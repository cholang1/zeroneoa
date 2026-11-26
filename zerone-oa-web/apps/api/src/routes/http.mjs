export function sendJson(response, status, payload) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    response.end(JSON.stringify(payload));
}

export function readBody(request, maxBytes = Infinity) {
    return new Promise((resolve, reject) => {
        let body = "";
        let bytes = 0;
        // 中文业务文本可能横跨两个网络分块，由同一个解码器拼接。
        request.setEncoding('utf8');
        request.on("data", (chunk) => {
            if (maxBytes !== Infinity) {
                bytes += Buffer.byteLength(chunk, "utf8");
                if (bytes > maxBytes) {
                    reject(new RangeError("请求体超过允许大小。"));
                    return;
                }
            }
            body += chunk;
        });
        request.on("end", () => {
            if (bytes > maxBytes) return;
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(error);
            }
        });
        request.on("error", reject);
    });
}
