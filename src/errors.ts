export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 500,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthRequiredError extends AppError {
  constructor(message = "米家登录凭证不存在或已经失效，请重新扫码授权。") {
    super(message, "AUTH_REQUIRED", 401);
  }
}

export class SyncBusyError extends AppError {
  constructor() {
    super("已有同步任务正在运行，请等待当前任务完成。", "SYNC_BUSY", 409);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
  }
}
