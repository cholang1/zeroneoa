import http from "node:http";
import {handleRequest} from "./routes/team.mjs";
import {createZeroAiV2Handler} from './routes/zeroAiV2.mjs';
import {requestAiChat} from "./services/ai.mjs";

import {createAccess} from './routes/auth.mjs';

export function createApiServer(store, {
    completeAi = requestAiChat,
    origin,
    setupKey = process.env.OA_SETUP_KEY,
    readPolicy = null
} = {}) {
    const zeroAi = createZeroAiV2Handler(store.agent, completeAi, store, readPolicy);
    const authorize = createAccess(store, origin, setupKey);
    return http.createServer((request, response) => handleRequest(store, request, response, zeroAi, authorize));
}
