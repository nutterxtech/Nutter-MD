import { logger } from "./lib/logger";
import { startBot } from "./bot/botEngine";

logger.info("NUTTER-XMD bot worker starting...");

startBot().catch((err) => {
  logger.error({ err }, "Bot engine crashed");
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled rejection");
  process.exit(1);
});
