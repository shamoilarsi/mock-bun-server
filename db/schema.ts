import { pgTable, text, bigint } from "drizzle-orm/pg-core";

export const wbtcSql = pgTable("wbtc_sql", {
  id: text("id").primaryKey().notNull(),
  
  // Using mode: 'bigint' ensures precision for large blockchain values.
  // If you prefer working with JS numbers and know values won't exceed 2^53, 
  // you can use { mode: 'number' } instead.
  blockNumber: bigint("block_number", { mode: "bigint" }),
  
  blockHash: text("block_hash"),
  transactionHash: text("transaction_hash"),
  transactionIndex: bigint("transaction_index", { mode: "bigint" }),
  logIndex: bigint("log_index", { mode: "bigint" }),
  
  address: text("address"),
  data: text("data"),
  topics: text("topics"), // Consider using jsonb() if this stores array data
  
  blockTimestamp: bigint("block_timestamp", { mode: "bigint" }),
});