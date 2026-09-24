/*
  MATCH-UP UNIVERSAL LEADERBOARD WORKER V6
  -----------------------------------------
  ONE Worker + ONE D1 database can support many Match-Up games.

  A game identifies itself through its public game.json file on:
    https://sliggett-hash.github.io/<repository>/game.json

  The Worker fetches that trusted configuration, snapshots the answer
  key at the start of the run, uses server timing, and recalculates
  the official score itself.

  Endpoints:
    GET  /health
    POST /run
    POST /finish
    POST /submit
    GET  /leaderboard?gameId=<id>
*/

const TIME_ZONE = "America/Detroit";
const TRUSTED_CONFIG_ORIGIN = "https://sliggett-hash.github.io";
const ALLOWED_BROWSER_ORIGIN = "https://sliggett-hash.github.io";

const BASE_CORRECT = 1000;
const STREAK_GROWTH = 1.50;
const WRONG_BASE_PENALTY = 2000;
const WRONG_PENALTY_GROWTH = 1.75;
const PERFECT_BONUS = 10000;
const SCORE_SCALE = 10;

const LIVE_TTL_MS = 30 * 60 * 1000;
const RUN_TTL_MS = 2 * 60 * 60 * 1000;
const MIN_LEADERBOARD_RUN_MS = 5000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if(request.method === "OPTIONS"){
      return corsResponse(null, 204, request);
    }

    try{
      assertAllowedOrigin(request);

      if(request.method === "GET" && url.pathname === "/health"){
        return corsResponse(
          {
            ok:true,
            version:"universal-leaderboard-v6"
          },
          200,
          request
        );
      }

      if(request.method === "POST" && url.pathname === "/run"){
        const body = await readJson(request);
        return corsResponse(
          await startRun(env, body),
          200,
          request
        );
      }

      if(request.method === "POST" && url.pathname === "/finish"){
        const body = await readJson(request);
        return corsResponse(
          await finishRun(env, body),
          200,
          request
        );
      }

      if(request.method === "POST" && url.pathname === "/submit"){
        const body = await readJson(request);
        return corsResponse(
          await submitScore(env, body),
          200,
          request
        );
      }

      if(request.method === "GET" && url.pathname === "/leaderboard"){
        return corsResponse(
          await getLeaderboard(env, url.searchParams.get("gameId")),
          200,
          request
        );
      }

      return corsResponse(
        { error:"Not found." },
        404,
        request
      );
    }catch(error){
      console.error(error);

      const status =
        Number.isInteger(error.status)
          ? error.status
          : 500;

      return corsResponse(
        {
          error:
            status >= 500
              ? "Leaderboard server error."
              : error.message
        },
        status,
        request
      );
    }
  }
};

function httpError(status, message){
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertAllowedOrigin(request){
  const origin = request.headers.get("Origin");

  if(!origin) return;

  if(origin === ALLOWED_BROWSER_ORIGIN) return;

  throw httpError(403, "Origin not allowed.");
}

function corsResponse(data, status, request){
  const origin = request.headers.get("Origin");

  const responseOrigin =
    origin === ALLOWED_BROWSER_ORIGIN
      ? origin
      : ALLOWED_BROWSER_ORIGIN;

  const headers = new Headers({
    "Access-Control-Allow-Origin":responseOrigin,
    "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type",
    "Cache-Control":"no-store",
    "Vary":"Origin"
  });

  if(status === 204){
    return new Response(null, { status, headers });
  }

  headers.set("Content-Type", "application/json; charset=utf-8");

  return new Response(
    JSON.stringify(data),
    { status, headers }
  );
}

async function readJson(request){
  try{
    return await request.json();
  }catch{
    throw httpError(400, "Invalid JSON.");
  }
}

function dayKey(nowMs = Date.now()){
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone:TIME_ZONE,
    year:"numeric",
    month:"2-digit",
    day:"2-digit"
  }).formatToParts(new Date(nowMs));

  const values = {};

  for(const part of parts){
    if(part.type !== "literal"){
      values[part.type] = part.value;
    }
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function validateGameId(gameId){
  if(
    typeof gameId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{2,63}$/.test(gameId)
  ){
    throw httpError(400, "Invalid game ID.");
  }

  return gameId;
}

function validateConfigUrl(value){
  let url;

  try{
    url = new URL(value);
  }catch{
    throw httpError(400, "Invalid game configuration URL.");
  }

  if(url.origin !== TRUSTED_CONFIG_ORIGIN){
    throw httpError(403, "Game configuration is not from the trusted GitHub Pages account.");
  }

  if(!url.pathname.endsWith("/game.json")){
    throw httpError(400, "Game configuration URL must end with /game.json.");
  }

  url.search = "";
  url.hash = "";

  return url.href;
}

async function fetchGameConfig(configUrl){
  const trustedUrl = validateConfigUrl(configUrl);

  const response = await fetch(
    `${trustedUrl}?server=${Date.now()}`,
    {
      headers:{
        "Accept":"application/json"
      },
      cf:{
        cacheTtl:0,
        cacheEverything:false
      }
    }
  );

  if(!response.ok){
    throw httpError(
      400,
      `Could not retrieve game configuration (${response.status}).`
    );
  }

  let config;

  try{
    config = await response.json();
  }catch{
    throw httpError(400, "game.json is not valid JSON.");
  }

  const gameId = validateGameId(config?.id);

  if(
    !config.pairs ||
    typeof config.pairs !== "object" ||
    Array.isArray(config.pairs)
  ){
    throw httpError(400, "game.json has no valid pairs object.");
  }

  const definitions = Object.keys(config.pairs);
  const images = Object.values(config.pairs);

  if(definitions.length < 2 || definitions.length > 20){
    throw httpError(400, "Games must contain 2–20 pairs.");
  }

  if(
    new Set(definitions).size !== definitions.length ||
    new Set(images).size !== images.length
  ){
    throw httpError(400, "Definitions and images must each be unique.");
  }

  for(const definition of definitions){
    if(
      typeof definition !== "string" ||
      definition.length < 1 ||
      definition.length > 8
    ){
      throw httpError(400, "Invalid definition ID.");
    }
  }

  for(const image of images){
    if(
      typeof image !== "string" ||
      image.length < 1 ||
      image.length > 8
    ){
      throw httpError(400, "Invalid image ID.");
    }
  }

  return {
    gameId,
    title:
      typeof config.title === "string"
        ? config.title.slice(0, 100)
        : gameId,
    pairs:config.pairs,
    pairCount:definitions.length,
    configUrl:trustedUrl
  };
}

function calculateAccuracy(matches, mistakes){
  const attempts = matches + mistakes;

  if(attempts === 0){
    return 100;
  }

  return (matches / attempts) * 100;
}

function accuracyMultiplier(accuracy){
  const a = accuracy / 100;
  return 1 + 2 * Math.pow(a, 10);
}

function speedMultiplier(elapsedMs){
  return 1 + 2 * Math.exp(-(elapsedMs / 1000) / 90);
}

function correctPointsFor(streak){
  const value =
    BASE_CORRECT *
    Math.pow(STREAK_GROWTH, streak - 1);

  return Math.round(value / 10) * 10;
}

function wrongPenaltyFor(mistakeNumber){
  const value =
    WRONG_BASE_PENALTY *
    Math.pow(
      WRONG_PENALTY_GROWTH,
      mistakeNumber - 1
    );

  return Math.round(value / 10) * 10;
}

function calculateRun(answerKey, pairCount, attempts, elapsedMs){
  if(
    !answerKey ||
    typeof answerKey !== "object" ||
    Array.isArray(answerKey)
  ){
    throw httpError(500, "Run answer key is invalid.");
  }

  if(!Array.isArray(attempts)){
    throw httpError(400, "Attempts are required.");
  }

  if(
    attempts.length < pairCount ||
    attempts.length > 200
  ){
    throw httpError(400, "Invalid number of attempts.");
  }

  const validImages = new Set(Object.values(answerKey));
  const matchedDefinitions = new Set();
  const matchedImages = new Set();

  let matches = 0;
  let mistakes = 0;
  let currentStreak = 0;
  let bestStreak = 0;
  let rawScore = 0;

  for(const attempt of attempts){
    if(
      !attempt ||
      typeof attempt.definition !== "string" ||
      typeof attempt.image !== "string"
    ){
      throw httpError(400, "Invalid attempt data.");
    }

    const definition = attempt.definition;
    const image = attempt.image;

    if(!(definition in answerKey)){
      throw httpError(400, "Invalid definition.");
    }

    if(!validImages.has(image)){
      throw httpError(400, "Invalid image.");
    }

    if(
      matchedDefinitions.has(definition) ||
      matchedImages.has(image)
    ){
      throw httpError(
        400,
        "Attempt sequence is not valid."
      );
    }

    const correct =
      answerKey[definition] === image;

    if(correct){
      matches += 1;
      currentStreak += 1;
      bestStreak = Math.max(
        bestStreak,
        currentStreak
      );

      rawScore +=
        correctPointsFor(currentStreak);

      matchedDefinitions.add(definition);
      matchedImages.add(image);
    }else{
      mistakes += 1;
      currentStreak = 0;

      rawScore = Math.max(
        0,
        rawScore - wrongPenaltyFor(mistakes)
      );
    }
  }

  if(
    matches !== pairCount ||
    matchedDefinitions.size !== pairCount ||
    matchedImages.size !== pairCount
  ){
    throw httpError(
      400,
      `A completed run must contain all ${pairCount} matches.`
    );
  }

  const accuracy =
    calculateAccuracy(matches, mistakes);

  const accMultiplier =
    accuracyMultiplier(accuracy);

  const timeMultiplier =
    speedMultiplier(elapsedMs);

  const perfectBonus =
    mistakes === 0
      ? PERFECT_BONUS
      : 0;

  const score =
    Math.floor(
      Math.max(0, rawScore + perfectBonus) *
      accMultiplier *
      timeMultiplier *
      SCORE_SCALE
    );

  return {
    matches,
    mistakes,
    bestStreak,
    rawScore,
    accuracy,
    accuracyMultiplier:accMultiplier,
    speedMultiplier:timeMultiplier,
    score
  };
}

async function startRun(env, body){
  const game =
    await fetchGameConfig(body?.configUrl);

  const now = Date.now();
  const runId = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO mg_runs (
      id,
      game_id,
      game_title,
      config_url,
      answer_key,
      pair_count,
      started_at,
      completed,
      submitted
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
  `)
    .bind(
      runId,
      game.gameId,
      game.title,
      game.configUrl,
      JSON.stringify(game.pairs),
      game.pairCount,
      now
    )
    .run();

  return {
    runId,
    gameId:game.gameId,
    startedAt:now
  };
}

async function finishRun(env, body){
  const runId =
    typeof body?.runId === "string"
      ? body.runId
      : "";

  if(!runId){
    throw httpError(400, "Run ID is required.");
  }

  const run = await env.DB.prepare(`
    SELECT *
    FROM mg_runs
    WHERE id = ?
  `)
    .bind(runId)
    .first();

  if(!run){
    throw httpError(404, "Run not found.");
  }

  if(run.completed){
    return publicRunResult(run);
  }

  const now = Date.now();

  if(now - Number(run.started_at) > RUN_TTL_MS){
    throw httpError(
      400,
      "This run expired. Start a new game."
    );
  }

  const elapsedMs =
    Math.max(
      1,
      now - Number(run.started_at)
    );

  let answerKey;

  try{
    answerKey = JSON.parse(run.answer_key);
  }catch{
    throw httpError(500, "Stored answer key is invalid.");
  }

  const result =
    calculateRun(
      answerKey,
      Number(run.pair_count),
      body.attempts,
      elapsedMs
    );

  const leaderboardEligible =
    elapsedMs >= MIN_LEADERBOARD_RUN_MS
      ? 1
      : 0;

  await env.DB.prepare(`
    UPDATE mg_runs
    SET
      finished_at = ?,
      elapsed_ms = ?,
      matches = ?,
      mistakes = ?,
      best_streak = ?,
      raw_score = ?,
      accuracy = ?,
      accuracy_multiplier = ?,
      speed_multiplier = ?,
      score = ?,
      leaderboard_eligible = ?,
      completed = 1
    WHERE id = ?
  `)
    .bind(
      now,
      elapsedMs,
      result.matches,
      result.mistakes,
      result.bestStreak,
      result.rawScore,
      result.accuracy,
      result.accuracyMultiplier,
      result.speedMultiplier,
      result.score,
      leaderboardEligible,
      runId
    )
    .run();

  return {
    runId,
    gameId:run.game_id,
    elapsedMs,
    ...result,
    leaderboardEligible:
      Boolean(leaderboardEligible)
  };
}

function publicRunResult(run){
  return {
    runId:run.id,
    gameId:run.game_id,
    elapsedMs:Number(run.elapsed_ms),
    matches:Number(run.matches),
    mistakes:Number(run.mistakes),
    bestStreak:Number(run.best_streak),
    rawScore:Number(run.raw_score),
    accuracy:Number(run.accuracy),
    accuracyMultiplier:
      Number(run.accuracy_multiplier),
    speedMultiplier:
      Number(run.speed_multiplier),
    score:Number(run.score),
    leaderboardEligible:
      Boolean(run.leaderboard_eligible)
  };
}

function cleanName(value){
  if(typeof value !== "string"){
    throw httpError(
      400,
      "A display name is required."
    );
  }

  const name =
    value
      .trim()
      .replace(/\s+/g, " ");

  if(name.length < 2 || name.length > 20){
    throw httpError(
      400,
      "Use first name + last initial, 20 characters maximum."
    );
  }

  if(!/^[A-Za-zÀ-ÖØ-öø-ÿ'’.\- ]+$/.test(name)){
    throw httpError(
      400,
      "Name contains unsupported characters."
    );
  }

  return name;
}

function betterThan(a, b){
  if(!b){
    return true;
  }

  if(Number(a.score) !== Number(b.score)){
    return Number(a.score) > Number(b.score);
  }

  if(Number(a.elapsed_ms) !== Number(b.elapsed_ms)){
    return Number(a.elapsed_ms) < Number(b.elapsed_ms);
  }

  if(Number(a.mistakes) !== Number(b.mistakes)){
    return Number(a.mistakes) < Number(b.mistakes);
  }

  return Number(a.submitted_at) < Number(b.submitted_at);
}

async function submitScore(env, body){
  const runId =
    typeof body?.runId === "string"
      ? body.runId
      : "";

  const displayName =
    cleanName(body?.displayName);

  if(!runId){
    throw httpError(400, "Run ID is required.");
  }

  const run = await env.DB.prepare(`
    SELECT *
    FROM mg_runs
    WHERE id = ?
  `)
    .bind(runId)
    .first();

  if(!run){
    throw httpError(404, "Run not found.");
  }

  if(!run.completed){
    throw httpError(
      400,
      "The game is not finished."
    );
  }

  if(!run.leaderboard_eligible){
    throw httpError(
      400,
      "This run is not eligible for the leaderboard."
    );
  }

  if(run.submitted){
    throw httpError(
      409,
      "This run was already submitted."
    );
  }

  const now = Date.now();
  const expiresAt = now + LIVE_TTL_MS;
  const today = dayKey(now);
  const gameId = run.game_id;

  await cleanup(env, now, today);

  const insert = await env.DB.prepare(`
    INSERT INTO mg_scores (
      run_id,
      game_id,
      display_name,
      score,
      raw_score,
      mistakes,
      best_streak,
      accuracy,
      elapsed_ms,
      submitted_at,
      expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      runId,
      gameId,
      displayName,
      Number(run.score),
      Number(run.raw_score),
      Number(run.mistakes),
      Number(run.best_streak),
      Number(run.accuracy),
      Number(run.elapsed_ms),
      now,
      expiresAt
    )
    .run();

  const scoreId =
    Number(insert.meta.last_row_id);

  const newScore = await env.DB.prepare(`
    SELECT *
    FROM mg_scores
    WHERE id = ?
  `)
    .bind(scoreId)
    .first();

  await env.DB.prepare(`
    UPDATE mg_runs
    SET submitted = 1
    WHERE id = ?
  `)
    .bind(runId)
    .run();

  const championRow =
    await env.DB.prepare(`
      SELECT
        dc.score_id,
        s.*
      FROM mg_daily_champions dc
      JOIN mg_scores s
        ON s.id = dc.score_id
      WHERE
        dc.game_id = ?
        AND dc.day_key = ?
    `)
      .bind(gameId, today)
      .first();

  let isDailyChampion = false;

  if(!championRow || betterThan(newScore, championRow)){
    if(championRow){
      await env.DB.prepare(`
        UPDATE mg_scores
        SET expires_at = ?
        WHERE id = ?
      `)
        .bind(
          now + LIVE_TTL_MS,
          Number(championRow.id)
        )
        .run();
    }

    await env.DB.prepare(`
      INSERT INTO mg_daily_champions (
        game_id,
        day_key,
        score_id
      )
      VALUES (?, ?, ?)
      ON CONFLICT(game_id, day_key)
      DO UPDATE SET
        score_id = excluded.score_id
    `)
      .bind(gameId, today, scoreId)
      .run();

    isDailyChampion = true;
  }

  const allTime =
    await env.DB.prepare(`
      SELECT *
      FROM mg_all_time_record
      WHERE game_id = ?
    `)
      .bind(gameId)
      .first();

  let isAllTimeRecord = false;

  if(
    !allTime ||
    Number(newScore.score) > Number(allTime.score) ||
    (
      Number(newScore.score) === Number(allTime.score) &&
      Number(newScore.elapsed_ms) < Number(allTime.elapsed_ms)
    )
  ){
    await env.DB.prepare(`
      INSERT INTO mg_all_time_record (
        game_id,
        display_name,
        score,
        raw_score,
        mistakes,
        best_streak,
        accuracy,
        elapsed_ms,
        achieved_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id)
      DO UPDATE SET
        display_name = excluded.display_name,
        score = excluded.score,
        raw_score = excluded.raw_score,
        mistakes = excluded.mistakes,
        best_streak = excluded.best_streak,
        accuracy = excluded.accuracy,
        elapsed_ms = excluded.elapsed_ms,
        achieved_at = excluded.achieved_at
    `)
      .bind(
        gameId,
        displayName,
        Number(run.score),
        Number(run.raw_score),
        Number(run.mistakes),
        Number(run.best_streak),
        Number(run.accuracy),
        Number(run.elapsed_ms),
        now
      )
      .run();

    isAllTimeRecord = true;
  }

  const leaderboard =
    await getLeaderboard(env, gameId);

  const rankIndex =
    leaderboard.top10.findIndex(
      item => item.id === scoreId
    );

  return {
    ok:true,
    gameId,
    score:Number(run.score),
    isDailyChampion,
    isAllTimeRecord,
    rank:
      rankIndex >= 0
        ? rankIndex + 1
        : null
  };
}

async function cleanup(env, now = Date.now(), today = dayKey(now)){
  /*
    Mark every previous day's champion as expired. Then remove those
    champion pointers. The expired-score cleanup can safely delete them.
  */
  await env.DB.prepare(`
    UPDATE mg_scores
    SET expires_at = ?
    WHERE id IN (
      SELECT score_id
      FROM mg_daily_champions
      WHERE day_key <> ?
    )
  `)
    .bind(now, today)
    .run();

  await env.DB.prepare(`
    DELETE FROM mg_daily_champions
    WHERE day_key <> ?
  `)
    .bind(today)
    .run();

  await env.DB.prepare(`
    DELETE FROM mg_scores
    WHERE
      expires_at <= ?
      AND NOT EXISTS (
        SELECT 1
        FROM mg_daily_champions dc
        WHERE dc.score_id = mg_scores.id
      )
  `)
    .bind(now)
    .run();

  await env.DB.prepare(`
    DELETE FROM mg_runs
    WHERE
      started_at <= ?
      AND submitted = 0
  `)
    .bind(now - RUN_TTL_MS)
    .run();
}

function publicScore(row, isChampion = false){
  return {
    id:Number(row.id),
    displayName:row.display_name,
    score:Number(row.score),
    rawScore:Number(row.raw_score),
    mistakes:Number(row.mistakes),
    bestStreak:Number(row.best_streak),
    accuracy:Number(row.accuracy),
    elapsedMs:Number(row.elapsed_ms),
    submittedAt:Number(row.submitted_at),
    isChampion
  };
}

async function getLeaderboard(env, requestedGameId){
  const gameId = validateGameId(requestedGameId);
  const now = Date.now();
  const today = dayKey(now);

  await cleanup(env, now, today);

  const champ = await env.DB.prepare(`
    SELECT
      s.*
    FROM mg_daily_champions dc
    JOIN mg_scores s
      ON s.id = dc.score_id
    WHERE
      dc.game_id = ?
      AND dc.day_key = ?
  `)
    .bind(gameId, today)
    .first();

  const champId =
    champ
      ? Number(champ.id)
      : -1;

  const live = await env.DB.prepare(`
    SELECT *
    FROM mg_scores
    WHERE
      game_id = ?
      AND expires_at > ?
      AND id <> ?
    ORDER BY
      score DESC,
      elapsed_ms ASC,
      mistakes ASC,
      submitted_at ASC
    LIMIT 9
  `)
    .bind(gameId, now, champId)
    .all();

  const top10 = [];

  if(champ){
    top10.push(
      publicScore(champ, true)
    );
  }

  for(const row of live.results || []){
    top10.push(
      publicScore(row, false)
    );
  }

  const allTime =
    await env.DB.prepare(`
      SELECT *
      FROM mg_all_time_record
      WHERE game_id = ?
    `)
      .bind(gameId)
      .first();

  return {
    gameId,
    dayKey:today,
    allTime:
      allTime
        ? {
            displayName:allTime.display_name,
            score:Number(allTime.score),
            rawScore:Number(allTime.raw_score),
            mistakes:Number(allTime.mistakes),
            bestStreak:Number(allTime.best_streak),
            accuracy:Number(allTime.accuracy),
            elapsedMs:Number(allTime.elapsed_ms),
            achievedAt:Number(allTime.achieved_at)
          }
        : null,
    todayChampion:
      champ
        ? publicScore(champ, true)
        : null,
    top10
  };
}
