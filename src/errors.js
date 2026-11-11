// 带错误码的异常：页面按 code 显示成访客自己的语言；message 是中文兜底。
export class AppError extends Error {
  constructor(code, message, params = {}) {
    super(message);
    this.code = code;
    this.params = params;
  }
}
