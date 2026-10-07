import { startMcpStdio } from "./mcpSession";

/**
 * MCP server over stdio.
 *
 * Newline-delimited JSON-RPC on stdin/stdout. stdout carries protocol traffic
 * and nothing else — every diagnostic goes to stderr, because one stray
 * console.log corrupts the stream and the client just sees a dead server.
 *
 * Deliberately dependency-free: this process is what a chat session talks to,
 * and it should start instantly and never break on an SDK upgrade.
 */
startMcpStdio();
