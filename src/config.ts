import * as vscode from "vscode";
import { OpenAICompatibleConfig } from "./providers/openaiCompatible";
import { StructuredOutputMode } from "./providers/types";

export function readModelConfig(): OpenAICompatibleConfig {
  const c = vscode.workspace.getConfiguration("agentic.model");
  return {
    baseUrl: c.get<string>("baseUrl", "http://localhost:11434/v1"),
    model: c.get<string>("name", "qwen3.8:27b"),
    apiKey: c.get<string>("apiKey", "") || undefined,
    contextWindow: c.get<number>("contextWindow", 32768),
    temperature: c.get<number>("temperature", 0.2),
    requestTimeoutMs: c.get<number>("requestTimeoutMs", 300000),
    structuredOutput: c.get<StructuredOutputMode>("structuredOutput", "json_schema"),
  };
}
