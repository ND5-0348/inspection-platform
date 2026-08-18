import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { ZodError } from "zod";
import { registerApiRoutes } from "./routes/api.js";

export async function buildApp() {
  const app = Fastify({ logger: true });
  await app.register(cors, {
    origin: process.env.WEB_ORIGIN?.split(",") ?? ["http://127.0.0.1:5173", "http://localhost:5173"],
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Client-Channel"],
  });
  await app.register(multipart, {
    limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 5 },
  });
  await app.register(registerApiRoutes, { prefix: "/api/v1" });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ message: "请求参数不正确", issues: error.issues });
    }
    const normalizedError = error instanceof Error ? error : new Error("未知服务错误");
    const reportedStatus = (error as { statusCode?: number }).statusCode;
    const isUploadInputError = ["只允许上传", "超过10MB", "无效的文件路径"].some((text) => normalizedError.message.includes(text));
    const statusCode = reportedStatus ?? (normalizedError.message.includes("已存在") ? 409 : isUploadInputError ? 400 : 500);
    return reply.code(statusCode).send({ message: statusCode >= 500 ? "服务暂时不可用" : normalizedError.message });
  });
  return app;
}
