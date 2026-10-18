package dev.portfolio.loginlab;

import java.util.*;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

@Service
public class RunStore {
  private final Database db;
  private final String fixtureHash;

  public RunStore(Database db, PasswordEncoder encoder) {
    this.db = db;
    fixtureHash = encoder.encode("Lab!2026Pass");
  }

  public Policy policy(String run) {
    Map<String, Object> r = db.one("SELECT policy FROM lab_runs WHERE id=?", run);
    if (r == null) throw new Failure(400, "RUN_NOT_FOUND", "실습 실행을 먼저 준비해 주세요.");
    return Policy.of(r.get("policy").toString());
  }

  public void create(String run, String policy) {
    if (!run.matches("[A-Za-z0-9_-]{1,80}")
        || !Set.of("normal", "short", "expiry").contains(policy))
      throw new Failure(400, "INVALID_RUN", "실습 범위가 올바르지 않습니다.");
    db.tx.executeWithoutResult(
        t -> {
          db.sql.update(
              "INSERT INTO lab_runs(id,policy) VALUES(?,?) ON CONFLICT(id) DO NOTHING",
              run,
              policy);
          for (String login : List.of("demo@lab.test", "other@lab.test")) {
            UUID id = UUID.randomUUID();
            int inserted =
                db.sql.update(
                    "INSERT INTO users(id,run_id,login_id,password_hash) VALUES(?,?,?,?) ON CONFLICT(run_id,login_id) DO NOTHING",
                    id,
                    run,
                    login,
                    fixtureHash);
            if (inserted > 0) db.sql.update("INSERT INTO user_preferences(user_id) VALUES(?)", id);
          }
        });
  }
}
