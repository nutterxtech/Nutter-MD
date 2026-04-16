import path from "path";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// In production (e.g. Heroku) serve the built React frontend and handle SPA routing.
if (process.env.NODE_ENV === "production") {
  const staticDir = path.join(process.cwd(), "artifacts/nutter-xmd/dist/public");
  const indexHtml = path.join(staticDir, "index.html");

  logger.info({ staticDir }, "Serving static frontend from");

  app.use(express.static(staticDir));

  // SPA fallback — Express 5 wildcard syntax
  app.get("/*splat", (_req: Request, res: Response, next: NextFunction) => {
    res.sendFile(indexHtml, (err) => {
      if (err) next(err);
    });
  });

  // Error handler for missing static files or other errors
  app.use(
    (err: NodeJS.ErrnoException, _req: Request, res: Response, _next: NextFunction) => {
      if (err.code === "ENOENT") {
        logger.error(
          { indexHtml },
          "Frontend dist not found — run build before deploying",
        );
        res
          .status(503)
          .send("Frontend not built. Ensure heroku-postbuild ran successfully.");
      } else {
        logger.error({ err }, "Unhandled server error");
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );
}

export default app;
