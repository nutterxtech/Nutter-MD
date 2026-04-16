import path from "path";
import express, { type Express, type Request, type Response } from "express";
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

// In production (e.g. Render) serve the built React frontend and handle SPA routing.
if (process.env.NODE_ENV === "production") {
  const staticDir = path.join(process.cwd(), "artifacts/nutter-xmd/dist/public");
  app.use(express.static(staticDir));
  app.get("*", (_req: Request, res: Response) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

export default app;
