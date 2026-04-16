import { Router, type IRouter } from "express";
import healthRouter from "./health";
import pairRouter from "./pair";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(pairRouter);
router.use(adminRouter);

export default router;
