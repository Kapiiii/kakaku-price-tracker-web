export class RequestError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

export const UUID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

export async function readJSONRequest(req: Request, limit: number) {
  const tooLarge = () => new RequestError("読み込みデータが上限を超えています。", 413);
  if (Number(req.headers.get("Content-Length")) > limit) throw tooLarge();
  if (req.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestError("JSON形式のリクエストを送信してください。", 415);
  }
  const reader = req.body?.getReader();
  if (!reader) throw new RequestError("リクエストが空です。");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw tooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    const body = JSON.parse(text + decoder.decode());
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new RequestError("JSONオブジェクトを送信してください。");
    }
    return { body, size };
  } catch (error) {
    if (error instanceof RequestError) throw error;
    void reader.cancel().catch(() => {});
    throw new RequestError("リクエストをJSONとして読み込めませんでした。");
  } finally {
    reader.releaseLock();
  }
}
