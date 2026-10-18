package dev.portfolio.loginlab;

public class Failure extends RuntimeException {
  public final int status;
  public final String code;

  public Failure(int status, String code, String message) {
    super(message);
    this.status = status;
    this.code = code;
  }

  public static Failure unavailable() {
    return new Failure(503, "DEPENDENCY_UNAVAILABLE", "서버 저장소에 연결할 수 없습니다. 잠시 후 다시 확인해 주세요.");
  }
}
