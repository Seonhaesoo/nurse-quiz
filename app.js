(function () {
  "use strict";

  // ===== 설정 =====
  const SUBJECTS = {
    basic:    { name: "기초간호학 개요", count: 35 },
    health:   { name: "보건간호학 개요", count: 15 },
    public:   { name: "공중보건학 개론", count: 20 },
    practice: { name: "실기",            count: 35 },
  };
  const SUBJECT_ORDER = ["basic", "health", "public", "practice"];
  const EXAM_MINUTES = 105; // 국시원 2026년도 기준: 105문항 · 105분
  const PASS_SUBJECT = 0.4;
  const PASS_TOTAL = 0.6;
  const KEYS = { session: "nam.session", wrong: "nam.wrong", history: "nam.history", theme: "nam.theme", auth: "nam.auth" };
  // 처음 들어올 때 보여 주는 환영용 로그인 (공개 사이트라 실제 보안 기능은 아님)
  const LOGIN = { id: "김민지", pw: "합격" };
  const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥"];

  // ===== 문제은행 =====
  const BANK = (window.QUESTION_BANK || []).filter(function (q) {
    return q && q.id && SUBJECTS[q.subject] && Array.isArray(q.choices) &&
      Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.choices.length;
  });
  const BY_ID = {};
  BANK.forEach(function (q) { BY_ID[q.id] = q; });

  // ===== 저장소 (실패해도 앱은 동작) =====
  const store = {
    get: function (k, fallback) {
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
      catch (e) { return fallback; }
    },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  // ===== 유틸 =====
  const $ = function (id) { return document.getElementById(id); };
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function range(n) { return Array.from({ length: n }, function (_, i) { return i; }); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function expText(q) { return String(q.exp || "").replace(/^\s*해설\s*[:：]\s*/, ""); }
  function pct(c, n) { return n ? Math.round((c / n) * 100) : 0; }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    return (d.getMonth() + 1) + "/" + d.getDate() + " " +
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function confirmBox(text, okLabel) {
    const dlg = $("confirmDialog");
    $("confirmText").textContent = text;
    $("confirmOk").textContent = okLabel || "확인";
    if (typeof dlg.showModal !== "function") return Promise.resolve(window.confirm(text));
    return new Promise(function (resolve) {
      dlg.addEventListener("close", function onClose() {
        dlg.removeEventListener("close", onClose);
        resolve(dlg.returnValue === "ok");
      });
      dlg.returnValue = "";
      dlg.showModal();
    });
  }

  // ===== 화면 전환 =====
  function show(view) {
    ["login", "home", "quiz", "result"].forEach(function (v) {
      $("view-" + v).classList.toggle("hidden", v !== view);
    });
    window.scrollTo(0, 0);
  }

  // ===== 세션 =====
  let session = null;
  let timerHandle = null;
  let reviewFilter = "wrong";

  function makeItems(ids) {
    return ids.map(function (id) {
      return { id: id, order: shuffle(range(BY_ID[id].choices.length)) };
    });
  }

  function startSession(opts) {
    if (!opts.ids.length) return;
    session = {
      mode: opts.mode,              // exam | practice | wrong
      title: opts.title,
      items: makeItems(opts.ids),
      answers: {},                  // index -> 표시된 보기 번호
      flags: {},
      current: 0,
      startedAt: Date.now(),
      endsAt: opts.mode === "exam" ? Date.now() + EXAM_MINUTES * 60 * 1000 : null,
    };
    saveSession();
    openQuiz();
  }

  function saveSession() { if (session) store.set(KEYS.session, session); }
  function clearSession() { session = null; store.del(KEYS.session); stopTimer(); }

  function isInstant() { return session.mode !== "exam"; }

  function isCorrect(idx) {
    const it = session.items[idx];
    const chosen = session.answers[idx];
    if (chosen === undefined) return false;
    return it.order[chosen] === BY_ID[it.id].answer;
  }

  // ===== 모의고사 구성 =====
  function examIds() {
    let ids = [];
    SUBJECT_ORDER.forEach(function (s) {
      const pool = shuffle(BANK.filter(function (q) { return q.subject === s; }).map(function (q) { return q.id; }));
      ids = ids.concat(pool.slice(0, SUBJECTS[s].count));
    });
    return ids; // 실제 시험처럼 과목 순서대로, 과목 안에서는 무작위
  }

  // ===== 오답노트 =====
  function getWrong() { return store.get(KEYS.wrong, {}); }
  function markWrong(id) {
    const w = getWrong();
    w[id] = { n: ((w[id] && w[id].n) || 0) + 1, t: Date.now() };
    store.set(KEYS.wrong, w);
  }
  function unmarkWrong(id) {
    const w = getWrong();
    if (w[id]) { delete w[id]; store.set(KEYS.wrong, w); }
  }
  function recordAnswer(idx) {
    const id = session.items[idx].id;
    if (isCorrect(idx)) {
      if (session.mode === "wrong") unmarkWrong(id);
    } else {
      markWrong(id);
    }
  }

  // ===== 로그인 =====
  let authed = store.get(KEYS.auth, false) === true;

  function showLogin() {
    stopTimer();
    $("loginError").classList.add("hidden");
    show("login");
    setTimeout(function () { $("loginId").focus(); }, 0);
  }

  $("loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    const id = $("loginId").value.trim();
    const pw = $("loginPw").value.trim();
    if (id === LOGIN.id && pw === LOGIN.pw) {
      authed = true;
      store.set(KEYS.auth, true);
      $("loginPw").value = "";
      renderHome();
    } else {
      $("loginError").classList.remove("hidden");
      $("loginPw").value = "";
      $("loginPw").focus();
    }
  });

  // ===== 홈 =====
  function renderHome() {
    if (!authed) return showLogin();
    $("bankCount").textContent = BANK.length;

    $("examComposition").innerHTML = SUBJECT_ORDER.map(function (s) {
      const have = BANK.filter(function (q) { return q.subject === s; }).length;
      const n = Math.min(have, SUBJECTS[s].count);
      return "<li><b>" + n + "문항</b>" + esc(SUBJECTS[s].name) + "</li>";
    }).join("");

    const sel = $("practiceSubject");
    if (!sel.options.length) {
      sel.innerHTML = '<option value="all">전체 과목</option>' + SUBJECT_ORDER.map(function (s) {
        return '<option value="' + s + '">' + esc(SUBJECTS[s].name) + "</option>";
      }).join("");
    }

    const wrongIds = Object.keys(getWrong()).filter(function (id) { return BY_ID[id]; });
    $("wrongCount").textContent = wrongIds.length;
    $("startWrongBtn").disabled = wrongIds.length === 0;
    $("clearWrongBtn").disabled = wrongIds.length === 0;

    const saved = store.get(KEYS.session, null);
    const valid = saved && saved.items && saved.items.every(function (it) { return BY_ID[it.id]; });
    $("resumeBox").classList.toggle("hidden", !valid);
    if (valid) {
      const answered = Object.keys(saved.answers).length;
      let info = saved.title + " · " + answered + "/" + saved.items.length + "문항 풀이";
      if (saved.endsAt) info += " · 남은 시간 " + fmtTime((saved.endsAt - Date.now()) / 1000);
      $("resumeInfo").textContent = info;
    }

    const hist = store.get(KEYS.history, []);
    $("clearHistoryBtn").disabled = hist.length === 0;
    $("historyList").innerHTML = hist.length ? hist.slice(0, 15).map(function (h) {
      const badge = h.mode === "exam"
        ? '<span class="badge ' + (h.pass ? "pass" : "fail") + '">' + (h.pass ? "합격" : "불합격") + "</span>"
        : "";
      return '<div class="history-item"><div><b>' + esc(h.title) + "</b>" + badge +
        '<div class="meta">' + fmtDate(h.at) + " · " + h.correct + "/" + h.total + "문항" +
        (h.minutes ? " · " + h.minutes + "분" : "") + "</div></div>" +
        '<div class="score">' + pct(h.correct, h.total) + "점</div></div>";
    }).join("") : '<p class="empty">아직 기록이 없어요. 모의고사를 한 번 풀어보세요.</p>';

    stopTimer();
    show("home");
  }

  // ===== 문제 풀이 =====
  function openQuiz() {
    $("quizTitle").textContent = session.title;
    $("qTotal").textContent = session.items.length;
    $("submitBtn").textContent = isInstant() ? "결과 보기" : "제출하고 채점하기";
    $("navGrid").classList.add("hidden");
    $("toggleNavBtn").setAttribute("aria-expanded", "false");
    buildNav();
    renderQuestion();
    show("quiz");
    startTimer();
  }

  function buildNav() {
    $("navGrid").innerHTML = session.items.map(function (_, i) {
      return '<button type="button" class="nav-cell" data-i="' + i + '">' + (i + 1) + "</button>";
    }).join("");
  }

  function updateNav() {
    const cells = $("navGrid").children;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const answered = session.answers[i] !== undefined;
      c.className = "nav-cell";
      if (answered) {
        if (isInstant()) c.classList.add(isCorrect(i) ? "correct" : "wrong");
        else c.classList.add("answered");
      }
      if (session.flags[i]) c.classList.add("flagged");
      if (i === session.current) c.classList.add("current");
    }
    const done = Object.keys(session.answers).length;
    $("progressBar").style.width = pct(done, session.items.length) + "%";
  }

  function renderQuestion() {
    const i = session.current;
    const it = session.items[i];
    const q = BY_ID[it.id];
    const chosen = session.answers[i];
    const reveal = isInstant() && chosen !== undefined;

    $("qNum").textContent = i + 1;
    $("qSubject").textContent = SUBJECTS[q.subject].name + (q.topic ? " · " + q.topic : "");
    $("qText").textContent = q.q;

    $("choices").innerHTML = it.order.map(function (orig, d) {
      let cls = "choice";
      if (reveal) {
        if (orig === q.answer) cls += " is-correct";
        else if (d === chosen) cls += " is-wrong";
      } else if (d === chosen) {
        cls += " selected";
      }
      return '<li><button type="button" class="' + cls + '" data-d="' + d + '"' + (reveal ? " disabled" : "") + ">" +
        '<span class="num">' + (d + 1) + "</span><span>" + esc(q.choices[orig]) + "</span></button></li>";
    }).join("");

    const fb = $("feedback");
    if (reveal) {
      const ok = isCorrect(i);
      const correctDisplay = it.order.indexOf(q.answer);
      fb.className = "feedback " + (ok ? "good" : "bad");
      fb.innerHTML = '<div class="verdict">' + (ok ? "정답이에요!" : "틀렸어요 · 정답 " + CIRCLED[correctDisplay]) + "</div>" +
        "<div>" + esc(expText(q)) + "</div>";
    } else {
      fb.className = "feedback hidden";
      fb.innerHTML = "";
    }

    $("prevBtn").disabled = i === 0;
    $("nextBtn").textContent = i === session.items.length - 1 ? "마지막 문항" : "다음 →";
    $("nextBtn").disabled = i === session.items.length - 1;
    $("flagBtn").setAttribute("aria-pressed", session.flags[i] ? "true" : "false");
    $("flagBtn").textContent = session.flags[i] ? "★ 표시됨" : "☆ 표시";
    updateNav();
  }

  function choose(d) {
    const i = session.current;
    if (isInstant() && session.answers[i] !== undefined) return; // 연습: 한 번 고르면 고정
    session.answers[i] = d;
    if (isInstant()) recordAnswer(i);
    saveSession();
    renderQuestion();
  }

  function go(i) {
    if (i < 0 || i >= session.items.length) return;
    session.current = i;
    saveSession();
    renderQuestion();
    $("qText").scrollIntoView({ block: "nearest" });
  }

  // ===== 타이머 =====
  function startTimer() {
    stopTimer();
    const el = $("timer");
    if (!session || !session.endsAt) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    const tick = function () {
      const left = (session.endsAt - Date.now()) / 1000;
      el.textContent = "⏱ " + fmtTime(left);
      el.classList.toggle("low", left <= 300);
      if (left <= 0) {
        stopTimer();
        finish(true);
      }
    };
    tick();
    timerHandle = setInterval(tick, 1000);
  }
  function stopTimer() {
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = null;
    $("timer").classList.add("hidden");
  }

  // ===== 채점 =====
  async function trySubmit() {
    const total = session.items.length;
    const done = Object.keys(session.answers).length;
    if (session.mode === "exam") {
      const msg = done < total
        ? "아직 " + (total - done) + "문항을 풀지 않았어요.\n그래도 제출할까요?"
        : "제출하고 채점할까요?";
      if (!(await confirmBox(msg, "제출"))) return;
    } else if (done < total) {
      if (!(await confirmBox("아직 " + (total - done) + "문항이 남았어요.\n여기까지 결과를 볼까요?", "결과 보기"))) return;
    }
    finish(false);
  }

  let lastResult = null;

  function finish(timeUp) {
    stopTimer();
    const s = session;
    const per = {};
    SUBJECT_ORDER.forEach(function (k) { per[k] = { c: 0, n: 0 }; });
    let correct = 0;
    const counted = []; // 연습 모드는 푼 문항만 채점
    s.items.forEach(function (it, i) {
      const answered = s.answers[i] !== undefined;
      if (s.mode !== "exam" && !answered) return;
      counted.push(i);
      const q = BY_ID[it.id];
      per[q.subject].n++;
      if (isCorrect(i)) { per[q.subject].c++; correct++; }
      if (s.mode === "exam") recordAnswer(i);
    });

    const total = counted.length;
    let pass = total > 0 && correct / total >= PASS_TOTAL;
    SUBJECT_ORDER.forEach(function (k) {
      if (per[k].n && per[k].c / per[k].n < PASS_SUBJECT) pass = false;
    });

    const minutes = Math.max(1, Math.round((Date.now() - s.startedAt) / 60000));
    lastResult = { session: s, counted: counted, per: per, correct: correct, total: total, pass: pass, timeUp: timeUp, minutes: minutes };

    if (total > 0) {
      const hist = store.get(KEYS.history, []);
      hist.unshift({ at: Date.now(), mode: s.mode, title: s.title, correct: correct, total: total, pass: pass, minutes: minutes,
        per: SUBJECT_ORDER.reduce(function (o, k) { o[k] = [per[k].c, per[k].n]; return o; }, {}) });
      store.set(KEYS.history, hist.slice(0, 50));
    }
    clearSession();
    reviewFilter = "wrong";
    renderResult();
  }

  function renderResult() {
    const r = lastResult;
    const s = r.session;
    const isExam = s.mode === "exam";
    const score = pct(r.correct, r.total);

    let hero = '<p class="muted">' + esc(s.title) + (r.timeUp ? " · 시간 종료로 자동 제출" : "") + "</p>";
    if (isExam) {
      hero += '<p class="verdict-big ' + (r.pass ? "pass" : "fail") + '">' + (r.pass ? "합격권이에요 🎉" : "아쉽게 불합격") + "</p>";
    }
    hero += '<p class="score-big">' + score + "<small>점</small></p>" +
      '<p class="muted">' + r.total + "문항 중 " + r.correct + "문항 정답 · " + r.minutes + "분</p>";
    if (isExam && !r.pass) {
      const failed = SUBJECT_ORDER.filter(function (k) { return r.per[k].n && r.per[k].c / r.per[k].n < PASS_SUBJECT; });
      const reasons = [];
      if (failed.length) reasons.push("과락: " + failed.map(function (k) { return SUBJECTS[k].name; }).join(", "));
      if (r.total && r.correct / r.total < PASS_TOTAL) reasons.push("전체 60% 미만");
      hero += '<p class="muted">' + esc(reasons.join(" · ")) + "</p>";
    }
    $("resultHero").innerHTML = hero;

    $("subjectScores").innerHTML = SUBJECT_ORDER.filter(function (k) { return r.per[k].n; }).map(function (k) {
      const p = r.per[k];
      const ratio = p.c / p.n;
      const fail = ratio < PASS_SUBJECT;
      return '<div class="ss-row"><span class="ss-name">' + esc(SUBJECTS[k].name) + "</span>" +
        '<span class="ss-val' + (fail ? " fail" : "") + '">' + p.c + "/" + p.n + " (" + pct(p.c, p.n) + "%)</span>" +
        '<div class="ss-bar" title="세로선: 과락 기준 40%"><span class="' + (fail ? "fail" : "") + '" style="width:' + pct(p.c, p.n) + '%"></span><i></i></div></div>';
    }).join("") || '<p class="empty">채점한 문항이 없어요.</p>';

    const wrongIds = r.counted.filter(function (i) { return !isCorrectIn(s, i); }).map(function (i) { return s.items[i].id; });
    $("retryWrongBtn").disabled = wrongIds.length === 0;
    $("retryWrongBtn").onclick = function () {
      startSession({ mode: "wrong", title: "틀린 문제 다시 풀기", ids: shuffle(wrongIds) });
    };

    renderReview();
    show("result");
  }

  function isCorrectIn(s, i) {
    const it = s.items[i];
    const c = s.answers[i];
    return c !== undefined && it.order[c] === BY_ID[it.id].answer;
  }

  function renderReview() {
    const r = lastResult;
    const s = r.session;
    document.querySelectorAll(".seg-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.filter === reviewFilter);
    });
    const list = r.counted.filter(function (i) { return reviewFilter === "all" || !isCorrectIn(s, i); });
    if (!list.length) {
      $("reviewList").innerHTML = '<p class="empty">' + (reviewFilter === "wrong" ? "틀린 문제가 없어요. 완벽해요!" : "문항이 없어요.") + "</p>";
      return;
    }
    $("reviewList").innerHTML = list.map(function (i) {
      const it = s.items[i];
      const q = BY_ID[it.id];
      const chosen = s.answers[i];
      const ok = isCorrectIn(s, i);
      const opts = it.order.map(function (orig, d) {
        let cls = "";
        if (orig === q.answer) cls = "c";
        else if (d === chosen) cls = "w";
        return '<li class="' + cls + '">' + CIRCLED[d] + " " + esc(q.choices[orig]) + "</li>";
      }).join("");
      return '<div class="review-item"><div class="r-head"><span class="mark ' + (ok ? "o" : "x") + '">' + (ok ? "O" : "X") + "</span>" +
        "<span>" + (i + 1) + "번 · " + esc(SUBJECTS[q.subject].name) + (q.topic ? " · " + esc(q.topic) : "") + "</span>" +
        (chosen === undefined ? "<span>· 안 푼 문항</span>" : "") + "</div>" +
        '<div class="r-q">' + esc(q.q) + "</div><ol>" + opts + "</ol>" +
        '<div class="r-exp">' + esc(expText(q)) + "</div></div>";
    }).join("");
  }

  // ===== 이벤트 =====
  $("homeBtn").addEventListener("click", async function () {
    if (!$("view-quiz").classList.contains("hidden")) {
      saveSession(); // 홈에서 '이어서 풀기'로 돌아올 수 있음
    }
    renderHome();
  });

  $("startExamBtn").addEventListener("click", async function () {
    if (store.get(KEYS.session, null) && !(await confirmBox("풀던 시험이 사라져요. 새로 시작할까요?", "새로 시작"))) return;
    startSession({ mode: "exam", title: "실전 모의고사", ids: examIds() });
  });

  $("startPracticeBtn").addEventListener("click", async function () {
    const subj = $("practiceSubject").value;
    const count = parseInt($("practiceCount").value, 10);
    let pool = BANK.filter(function (q) { return subj === "all" || q.subject === subj; }).map(function (q) { return q.id; });
    pool = shuffle(pool);
    if (count > 0) pool = pool.slice(0, count);
    if (store.get(KEYS.session, null) && !(await confirmBox("풀던 시험이 사라져요. 새로 시작할까요?", "새로 시작"))) return;
    const title = (subj === "all" ? "전체 과목" : SUBJECTS[subj].name) + " 연습";
    startSession({ mode: "practice", title: title, ids: pool });
  });

  $("startWrongBtn").addEventListener("click", async function () {
    const ids = Object.keys(getWrong()).filter(function (id) { return BY_ID[id]; });
    if (store.get(KEYS.session, null) && !(await confirmBox("풀던 시험이 사라져요. 새로 시작할까요?", "새로 시작"))) return;
    startSession({ mode: "wrong", title: "오답노트", ids: shuffle(ids) });
  });

  $("clearWrongBtn").addEventListener("click", async function () {
    if (await confirmBox("오답노트를 모두 비울까요?", "비우기")) { store.del(KEYS.wrong); renderHome(); }
  });
  $("clearHistoryBtn").addEventListener("click", async function () {
    if (await confirmBox("최근 기록을 모두 지울까요?", "지우기")) { store.del(KEYS.history); renderHome(); }
  });

  $("resumeBtn").addEventListener("click", function () {
    session = store.get(KEYS.session, null);
    if (!session) return renderHome();
    if (session.endsAt && session.endsAt <= Date.now()) { openQuiz(); return; } // 타이머가 즉시 자동 제출
    openQuiz();
  });
  $("discardBtn").addEventListener("click", async function () {
    if (await confirmBox("풀던 시험을 버릴까요?", "버리기")) { clearSession(); renderHome(); }
  });

  $("choices").addEventListener("click", function (e) {
    const b = e.target.closest(".choice");
    if (b && !b.disabled) choose(parseInt(b.dataset.d, 10));
  });
  $("navGrid").addEventListener("click", function (e) {
    const b = e.target.closest(".nav-cell");
    if (b) go(parseInt(b.dataset.i, 10));
  });
  $("toggleNavBtn").addEventListener("click", function () {
    const grid = $("navGrid");
    const open = grid.classList.toggle("hidden") === false;
    this.setAttribute("aria-expanded", open ? "true" : "false");
  });
  $("prevBtn").addEventListener("click", function () { go(session.current - 1); });
  $("nextBtn").addEventListener("click", function () { go(session.current + 1); });
  $("flagBtn").addEventListener("click", function () {
    const i = session.current;
    if (session.flags[i]) delete session.flags[i]; else session.flags[i] = true;
    saveSession();
    renderQuestion();
  });
  $("submitBtn").addEventListener("click", trySubmit);
  $("quitBtn").addEventListener("click", async function () {
    if (await confirmBox("그만두면 지금까지 푼 내용이 사라져요.\n(나중에 이어서 풀려면 위의 로고를 눌러 홈으로 가세요)", "그만두기")) {
      clearSession();
      renderHome();
    }
  });

  $("backHomeBtn").addEventListener("click", renderHome);
  document.querySelector(".seg").addEventListener("click", function (e) {
    const b = e.target.closest(".seg-btn");
    if (!b) return;
    reviewFilter = b.dataset.filter;
    renderReview();
  });

  document.addEventListener("keydown", function (e) {
    if (!authed || $("view-quiz").classList.contains("hidden") || !session) return;
    if ($("confirmDialog").open) return;
    if (e.target.matches("input, select, textarea")) return;
    if (e.key >= "1" && e.key <= "5") {
      const d = parseInt(e.key, 10) - 1;
      if (d < session.items[session.current].order.length) choose(d);
    } else if (e.key === "ArrowRight") {
      go(session.current + 1);
    } else if (e.key === "ArrowLeft") {
      go(session.current - 1);
    }
  });

  // 테마
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
  }
  applyTheme(store.get(KEYS.theme, null));
  $("themeBtn").addEventListener("click", function () {
    const cur = document.documentElement.getAttribute("data-theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    applyTheme(next);
    store.set(KEYS.theme, next);
  });

  renderHome();
})();
