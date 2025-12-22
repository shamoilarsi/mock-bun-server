import { createClient } from "@clickhouse/client";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./db/schema";
import { eq } from "drizzle-orm";

const connectionString = process.env.PLANETSCALE_DATABASE_URL!;

const postgresClient = postgres(connectionString, { prepare: false });

export const postgresDb = drizzle(postgresClient, { schema });

type TransferData = {
  time_bucket: string;
  total_transfers: string;
  total_amount: number;
  avg_amount: number;
  min_amount: number;
  max_amount: number;
  open_amount: number;
  close_amount: number;
  last_block_number: string;
  median_amount: number;
};

const clickhouseClient = createClient({
  url: process.env.CLICKHOUSE_URL!,
  username: process.env.CLICKHOUSE_USERNAME!,
  password: process.env.CLICKHOUSE_PASSWORD!,
  clickhouse_settings: { use_query_cache: 0 },
});

// Helper to add CORS headers to any response
const cors = (response: Response) => {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
};

const server: Bun.Server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);

    // Handle preflight OPTIONS requests
    if (req.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return cors(new Response("OK", { status: 200 }));
    }

    if (req.method === "GET" && url.pathname === "/transfers") {
      // Extract query parameters
      const n = url.searchParams.get("n");
      const timeInterval = url.searchParams.get("timeInterval");
      const token = url.searchParams.get("token");
      const toBlock = url.searchParams.get("toBlock");
      const fromTimestamp = url.searchParams.get("fromTimestamp"); // in seconds
      const toTimestamp = url.searchParams.get("toTimestamp"); // in seconds

      console.log("Extracted parameters:", {
        timeInterval,
        token,
        toBlock,
        fromTimestamp,
        toTimestamp,
      });

      // Validate required parameters
      if (!timeInterval || !token) {
        return cors(
          new Response(
            JSON.stringify({
              error: "Missing required parameters",
              required: ["timeInterval", "token"],
              optional: ["toBlock", "fromTimestamp", "toTimestamp", "n"],
              provided: {
                timeInterval,
                token,
                toBlock,
                fromTimestamp,
                toTimestamp,
                n,
              },
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      }

      try {
        if (token !== "WBTC") {
          return cors(
            new Response(
              JSON.stringify({ error: "Invalid token", valid: ["WBTC"] }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            )
          );
        }

        let table = null;

        if (timeInterval === "1h") {
          table = "wbtc_1h_transfers";
        }
        if (timeInterval === "1m") {
          table = "wbtc_1m_transfers";
        }

        if (!table) {
          return cors(
            new Response(
              JSON.stringify({
                error: "Invalid time interval",
                valid: ["1h", "1m"],
              }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            )
          );
        }

        console.time("API_request");

        const query = `
          (
            SELECT 
              time_bucket, 
              countMerge(total_transfers) as total_transfers, 
              sumMerge(total_amount) as total_amount, 
              avgMerge(avg_amount) as avg_amount, 
              minMerge(min_amount) as min_amount, 
              maxMerge(max_amount) as max_amount,
              argMinMerge(open_amount) as open_amount,
              argMaxMerge(close_amount) as close_amount,
              argMaxMerge(last_block_number) as last_block_number,
              quantileMerge(0.5)(median_amount) as median_amount
            FROM "${table}"
            WHERE 1=1
            ${
              fromTimestamp
                ? `AND time_bucket >= toDateTime(${fromTimestamp})`
                : ""
            }
            ${
              toTimestamp ? `AND time_bucket <= toDateTime(${toTimestamp})` : ""
            }
            GROUP BY time_bucket
            ${toBlock ? `HAVING last_block_number <= ${+toBlock}` : ""}
            ORDER BY last_block_number DESC
          )

          ${
            toBlock
              ? `UNION ALL

          (
            SELECT 
              time_bucket, 
              countMerge(total_transfers) as total_transfers, 
              sumMerge(total_amount) as total_amount, 
              avgMerge(avg_amount) as avg_amount, 
              minMerge(min_amount) as min_amount, 
              maxMerge(max_amount) as max_amount,
              argMinMerge(open_amount) as open_amount,
              argMaxMerge(close_amount) as close_amount,
              argMaxMerge(last_block_number) as last_block_number,
              quantileMerge(0.5)(median_amount) as median_amount
            FROM "${table}"
            WHERE 1=1
            ${
              fromTimestamp
                ? `AND time_bucket >= toDateTime(${fromTimestamp})`
                : ""
            }
            ${
              toTimestamp ? `AND time_bucket <= toDateTime(${toTimestamp})` : ""
            }
            GROUP BY time_bucket
            ${toBlock ? `HAVING last_block_number >= ${+toBlock}` : ""}
            ORDER BY last_block_number ASC
            LIMIT 1
          )`
              : ""
          }
        `;

        const maxRetries = 10; // Maximum number of retry attempts
        const retryDelay = 250; // Delay between retries in milliseconds
        let attempt = 0;
        let finalResults: { data: TransferData[]; rows: number } = {
          data: [],
          rows: 0,
        };

        while (attempt < maxRetries) {
          attempt++;
          console.log(`Query attempt ${attempt}/${maxRetries}`);

          console.time("clickhouse_query");
          const rows = await clickhouseClient.query({ query });
          console.timeEnd("clickhouse_query");

          const result = await rows.json();
          finalResults = {
            data: result.data as TransferData[],
            rows: result.rows as number,
          };

          const hasData = result.rows && result.rows > 0;

          let blockMatches = true;
          if (toBlock) {
            if (!hasData || +finalResults.data[0]!.last_block_number < +toBlock)
              blockMatches = false;
          }

          if (hasData && blockMatches) {
            console.timeLog(
              "API_request",
              `Query succeeded on attempt ${attempt}`
            );
            break;
          }

          if (attempt >= maxRetries) {
            console.timeLog(
              "API_request",
              `Max retries reached (${maxRetries})`
            );
            finalResults = { data: [], rows: 0 };
            break;
          }

          const reason = !hasData ? "No data found" : `Block not reached yet`;
          console.log(`${reason}, retrying in ${retryDelay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }

        console.timeEnd("API_request");

        if (n) {
          finalResults.data = finalResults.data.slice(0, +n);
          finalResults.rows = finalResults.data.length;
        }

        return cors(
          new Response(
            JSON.stringify({
              parameters: {
                timeInterval,
                tokenPair: token,
                toBlock: toBlock ? parseInt(toBlock) : null,
                fromTimestamp: fromTimestamp ? parseInt(fromTimestamp) : null,
                toTimestamp: toTimestamp ? parseInt(toTimestamp) : null,
                n: n ? parseInt(n) : null,
              },
              data: finalResults.data,
              count: finalResults.rows,
            }),
            {
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      } catch (error) {
        console.error("Query error:", error);
        return cors(
          new Response(
            JSON.stringify({
              error: "Query failed",
              message: error instanceof Error ? error.message : "Unknown error",
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      }
    }

    if (req.method === "GET" && url.pathname === "/postgres/transfers") {
      const allLogs = await postgresDb.select().from(schema.arbitrumOneCleanSql2).where(eq(schema.arbitrumOneCleanSql2.from, "0x0e4831319a50228b9e450861297ab92dee15b44f"));

      const count = allLogs.length;
      const result = allLogs.map((log) => ({
        ...log,
        blockNumber: log.blockNumber?.toString(),
      }));

      return cors(new Response(JSON.stringify({ count, result }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }

    return cors(new Response("Not Found", { status: 404 }));
  },
});

console.log(`Server running on http://localhost:${server.port}`);
console.log(`Query: http://localhost:${server.port}/transfers`);
console.log(`Query: http://localhost:${server.port}/postgres/transfers`);
console.log(`Health: http://localhost:${server.port}/health`);
