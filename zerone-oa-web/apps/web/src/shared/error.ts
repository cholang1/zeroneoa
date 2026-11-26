export function appError(error: unknown) {
    return error instanceof Error ? error.message : "未知错误";
}
