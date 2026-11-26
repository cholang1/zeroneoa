export function clearLegacySession() {
    try {
        localStorage.removeItem("oa-v2-session-user");
        localStorage.removeItem("oa-session-user");
    } catch {
        // 本地存储不可用时不影响服务端验身。
    }
}
