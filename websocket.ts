type JsonRpcRequest = {
  jsonrpc: string;
  method: string;
  params?: any[];
  id: number | string;
};

type JsonRpcResponse = {
  jsonrpc: string;
  id: number | string;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
};

type Subscription = {
  id: string;
  type: string;
  ws: any;
};

function generateMockTransaction(index: number, blockNumber: number) {
  const txHash = `0x${Math.random().toString(16).slice(2).padStart(64, "0")}`;
  const from = `0x${Math.random().toString(16).slice(2).padStart(40, "0")}`;
  const to = `0x${Math.random().toString(16).slice(2).padStart(40, "0")}`;

  return {
    hash: txHash,
    nonce: `0x${index.toString(16)}`,
    blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    blockNumber: `0x${blockNumber.toString(16)}`,
    transactionIndex: `0x${index.toString(16)}`,
    from,
    to,
    value: `0x${Math.floor(Math.random() * 1000000).toString(16)}`,
    gas: "0x5208",
    gasPrice: `0x${Math.floor(Math.random() * 100000 + 20000).toString(16)}`,
    input: "0x",
    v: "0x1b",
    r: `0x${Math.random().toString(16).slice(2).padStart(64, "0")}`,
    s: `0x${Math.random().toString(16).slice(2).padStart(64, "0")}`,
  };
}

function generateMockReceipt(transaction: any, index: number, blockNumber: number) {
  return {
    transactionHash: transaction.hash,
    transactionIndex: transaction.transactionIndex,
    blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    blockNumber: `0x${blockNumber.toString(16)}`,
    from: transaction.from,
    to: transaction.to,
    cumulativeGasUsed: `0x${((index + 1) * 21000).toString(16)}`,
    gasUsed: "0x5208",
    contractAddress: null,
    logs: [],
    logsBloom: "0x" + "0".repeat(512),
    status: "0x1",
    effectiveGasPrice: transaction.gasPrice,
    type: "0x0",
  };
}

function generateMiniBlock(blockNumber: number, index: number) {
  let transactions: ReturnType<typeof generateMockTransaction>[] = [];
  let receipts: ReturnType<typeof generateMockReceipt>[] = [];
  
  // First, include ALL pending transactions from realtime_sendRawTransaction
  if (pendingTransactions.length > 0) {
    const toInclude = pendingTransactions.splice(0, pendingTransactions.length);
    transactions = toInclude.map(pt => pt.transaction);
    receipts = toInclude.map(pt => pt.receipt);
    console.log(`Including ${toInclude.length} pending transaction(s) in mini block`);
  }
  
  // Then add random mock transactions to fill the mini block
  const additionalTxs = Math.floor(Math.random() * 3) + 1; // 1-3 additional transactions
  const startIndex = transactions.length;
  
  for (let i = 0; i < additionalTxs; i++) {
    const tx = generateMockTransaction(startIndex + i, blockNumber);
    const receipt = generateMockReceipt(tx, startIndex + i, blockNumber);
    transactions.push(tx);
    receipts.push(receipt);
  }

  const numTxs = transactions.length;

  return {
    payload_id: `0x${Math.random().toString(16).slice(2).padStart(16, "0")}`,
    block_number: blockNumber,
    index,
    tx_offset: index * 10,
    log_offset: index * 5,
    gas_offset: index * 21000,
    timestamp: Date.now(),
    gas_used: numTxs * 21000,
    transactions,
    receipts,
  };
}

// Active subscriptions
const subscriptions = new Map<string, Subscription>();
let subscriptionCounter = 0;

// Mini block generation
let currentBlockNumber = 100;
let miniBlockIndex = 0;

// Pending transactions queue (from realtime_sendRawTransaction)
type PendingTransaction = {
  rawTx: string;
  transaction: ReturnType<typeof generateMockTransaction>;
  receipt: ReturnType<typeof generateMockReceipt>;
};
const pendingTransactions: PendingTransaction[] = [];

async function processRawTransaction(rawTx: string | undefined, requestId: number | string, source: string) {
  if (!rawTx || typeof rawTx !== "string" || !rawTx.startsWith("0x")) {
    return {
      success: false,
      error: {
        code: -32602,
        message: "Invalid raw transaction parameter",
      },
    };
  }
  
  const txIndex = pendingTransactions.length;
  const mockTx = generateMockTransaction(txIndex, currentBlockNumber);
  const receipt = generateMockReceipt(mockTx, txIndex, currentBlockNumber);
  
  pendingTransactions.push({ rawTx, transaction: mockTx, receipt });
  
  console.log(`Transaction queued (${source}): ${receipt.transactionHash} (will appear in next mini block)`);
  
  // Simulate transaction processing delay (10-100ms)
  // Very rarely (1% chance) simulate timeout for testing
  const shouldTimeout = Math.random() < 0.01;
  const delay = shouldTimeout ? 10000 : Math.random() * 90 + 10;
  
  await new Promise(resolve => setTimeout(resolve, delay));
  
  if (shouldTimeout) {
    console.log(`Transaction timeout (${source}): request ${requestId}`);
    return {
      success: false,
      error: {
        code: -32000,
        message: "realtime transaction expired",
      },
    };
  }
  
  console.log(`Transaction receipt returned (${source}): ${receipt.transactionHash}`);
  return {
    success: true,
    result: receipt,
  };
}

function startMiniBlockGeneration() {
  function generateAndScheduleNext() {
    const miniBlock = generateMiniBlock(currentBlockNumber, miniBlockIndex);

    for (const [subId, sub] of subscriptions.entries()) {
      if (sub.type === "miniBlocks") {
        try {
          sub.ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "eth_subscription",
              params: {
                subscription: subId,
                result: miniBlock,
              },
            })
          );
        } catch (error) {
          console.error(`Failed to send to subscription ${subId}:`, error);
          subscriptions.delete(subId);
        }
      }
    }

    miniBlockIndex++;
    // Every 10 mini blocks, advance to next block number
    if (miniBlockIndex % 10 === 0) {
      currentBlockNumber++;
      miniBlockIndex = 0;
    }

    setTimeout(generateAndScheduleNext, Math.random() * 400 + 100);
  }

  generateAndScheduleNext();
}

async function handleJsonRpcMessage(ws: any, message: JsonRpcRequest) {
  const response: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: message.id,
  };

  try {
    if (message.method === "eth_subscribe") {
      const [subscriptionType, ...params] = message.params || [];

      if (subscriptionType === "miniBlocks") {
        const subId = `0x${(++subscriptionCounter).toString(16)}`;
        subscriptions.set(subId, {
          id: subId,
          type: "miniBlocks",
          ws,
        });

        response.result = subId;
        console.log(`New miniBlocks subscription: ${subId}`);
      } else {
        response.error = {
          code: -32602,
          message: `Unsupported subscription type: ${subscriptionType}`,
        };
      }
      
      ws.send(JSON.stringify(response));
    }

    else if (message.method === "eth_unsubscribe") {
      const [subId] = message.params || [];
      const existed = subscriptions.delete(subId);
      response.result = existed;
      console.log(`Unsubscribed: ${subId}`);
      
      ws.send(JSON.stringify(response));
    }
    else if (message.method === "realtime_sendRawTransaction") {
      const [rawTx] = message.params || [];
      const result = await processRawTransaction(rawTx, message.id, "WebSocket");
      
      if (result.success) {
        response.result = result.result;
      } else {
        response.error = result.error;
      }
      
      ws.send(JSON.stringify(response));
    }

    else {
      response.error = {
        code: -32601,
        message: `Method not supported in WebSocket: ${message.method}`,
      };
      ws.send(JSON.stringify(response));
    }
  } catch (error) {
    response.error = {
      code: -32603,
      message: error instanceof Error ? error.message : "Internal error",
    };
    ws.send(JSON.stringify(response));
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

startMiniBlockGeneration();

const server = Bun.serve({
  port: 3001,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (url.pathname === "/") {
      if (req.headers.get("upgrade") === "websocket") {
        const success = server.upgrade(req);
        if (success) {
          return undefined;
        }
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      
      if (req.method === "POST") {
        try {
          const body = await req.json() as JsonRpcRequest;
          
          if (body.method === "realtime_sendRawTransaction") {
            const [rawTx] = body.params || [];
            const result = await processRawTransaction(rawTx, body.id, "HTTP");
            
            if (result.success) {
              return Response.json({
                jsonrpc: "2.0",
                id: body.id,
                result: result.result,
              }, { headers: corsHeaders() });
            } else {
              return Response.json({
                jsonrpc: "2.0",
                id: body.id,
                error: result.error,
              }, { headers: corsHeaders() });
            }
          }
          
          return Response.json({
            jsonrpc: "2.0",
            id: body.id || null,
            error: {
              code: -32601,
              message: `Method not supported: ${body.method}`,
            },
          }, { headers: corsHeaders() });
        } catch (error) {
          return Response.json({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32700,
              message: "Parse error",
            },
          }, { status: 400, headers: corsHeaders() });
        }
      }
    }

    if (url.pathname === "/health") {
      return new Response("OK", { status: 200, headers: corsHeaders() });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  },
  websocket: {
    open(ws) {
      console.log("WebSocket client connected");
    },
    message(ws, message) {
      try {
        const data = typeof message === "string" ? message : message.toString();
        const jsonRpcRequest = JSON.parse(data) as JsonRpcRequest;
        console.log(`Received: ${jsonRpcRequest.method}`);
        handleJsonRpcMessage(ws, jsonRpcRequest);
      } catch (error) {
        console.error("Failed to parse message:", error);
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32700,
              message: "Parse error",
            },
          })
        );
      }
    },
    close(ws) {
      for (const [subId, sub] of subscriptions.entries()) {
        if (sub.ws === ws) {
          subscriptions.delete(subId);
          console.log(`Cleaned up subscription: ${subId}`);
        }
      }
      console.log("WebSocket client disconnected");
    },
  },
});

console.log(`MegaETH Realtime API Mock Server running on port ${server.port}`);
console.log(`\nWebSocket endpoint: ws://localhost:${server.port}`);
console.log("  - eth_subscribe (miniBlocks)");
console.log("  - eth_unsubscribe");
console.log("  - realtime_sendRawTransaction");
console.log(`\nHTTP JSON-RPC endpoint: http://localhost:${server.port}`);
console.log("  - realtime_sendRawTransaction");

