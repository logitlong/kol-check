// 启动时读取项目根目录的 .env（如果有）。必须在其他模块之前 import。
import path from "node:path";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"));
} catch {
  // 没有 .env 就用系统环境变量
}
