export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const unauthorized = (m = "unauthorized") => new HttpError(401, m);
export const forbidden = (m = "forbidden") => new HttpError(403, m);
export const notFound = (m = "not found") => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);
