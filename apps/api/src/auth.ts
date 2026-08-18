import type { FastifyReply, FastifyRequest } from "fastify";
import type { User, UserRole } from "./domain/types.js";
import { store } from "./store/memory-store.js";

export function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

export function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles?: UserRole[],
): User | undefined {
  const user = store.userForToken(bearerToken(request));
  if (!user) {
    void reply.code(401).send({ message: "登录已失效，请重新登录" });
    return undefined;
  }
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    void reply.code(403).send({ message: "没有执行该操作的权限" });
    return undefined;
  }
  return user;
}

