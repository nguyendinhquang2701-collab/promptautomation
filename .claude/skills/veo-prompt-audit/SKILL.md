---
name: veo-prompt-audit
description: Audit Veo 3 / video-AI prompts for policy risk and render-error likelihood. Use whenever the user provides one or more video prompts (pasted text or a file, often numbered scenes) and asks to check, audit, review, or find risky/error-prone/boring prompts before rendering.
---

# Veo 3 Prompt Audit

You are auditing text-to-video prompts (usually Veo 3, 8-second scenes for historical/documentary B-roll) BEFORE the user spends money rendering them. Scan EVERY prompt, flag problems, and propose a concrete rewritten replacement for each flagged prompt. The user's priorities, in order: (1) no policy violations, (2) no render errors, (3) watchable — the viewer always has something real to look at.

## How to work

1. Parse the input into individual prompts (usually numbered `1.`, `2.`, ...). Count them.
2. Check each prompt against ALL checklists below. One prompt can have multiple findings.
3. Report in Vietnamese using the output format at the end. Quote the exact offending phrase for every finding.
4. Be precise about verb-vs-noun to avoid false alarms (see "Do NOT flag" lists).

## A. ⛔ POLICY RISK (Veo will likely refuse, or the platform may flag the video)

- **Real person names**: any real politician, celebrity, athlete, or real historical figure named directly (e.g. Ho Chi Minh, Trump, Che, Ed Whitman). Correct form is an approved codename (A Khan, A Lu, A Nam, Asen / A Chen, A Cua, A Bon / A Chi, Ba Mom, Ba Lac / May Kool, May Phuong, May Nu — numbered A Khan 1, A Lu 2... when exhausted) or a "the ..." epithet (the Silver-Bearded Statesman). Physical description of the person is fine; the name is not.
- **Violence / gore**: weapons aimed or fired (aims a rifle, opens fire, machine gun pointed), corpses, dead bodies, blood, wounds, mass graves, skulls, massacre depicted, bombs falling, explosions over people, torture, execution, armed men in combat, "rifle at the ready", bombers/warplanes/fighter jets overhead, air raids/airstrikes.
- **Real brands / organizations** in the visual: company names (United Fruit, Chiquita...), CIA, terrorist orgs, logos, branded labels.
- **Readable on-screen text**: headlines, typed words forming on paper, calendar pages showing dates, signs, labels like `labeled 'X'`. Veo renders text as garbage AND it wastes the shot.

**Fix pattern**: retell through a calm AFTERMATH that still contains people doing ordinary actions (soldiers slowly patrolling an empty square at dawn; a woman picking up a fallen hat; mourners placing candles and white flowers by wooden crosses) — never an empty frame, never the violent instant. Replace org names with generic nouns ("the fruit company", "government men in dark suits"). Replace text props with people/place scenes.

## B. 🔧 RENDER-ERROR RISK (video models physically cannot do these — artifacts guaranteed)

1. **Transformation moments** — the instant an object changes form. Active verbs acting on objects: cuts/chops/slices/severs/peels/splits/tears/snaps/carves/saws/rips/shreds/grates/grinds/crushes/smashes/shatters/squeezes/kneads/threshes/reaps/mows/fells/husks/shucks + the/a/an/off/open/down; breaks open/apart/in half; cracks the egg; pounds the; pressing juice/sugarcane; plucks; picks a/the (detaching — but "picks up" a rigid object is FINE). The model duplicates the object instead of transforming it (bunch stays on the tree AND appears in the hand).
   - Fix: choose BEFORE (tool raised, no contact yet) or AFTER (result fully done: carries a freshly harvested bunch — source out of frame; a plate of fully arranged slices).
2. **Partial/ambiguous states**: half-peeled, half-cut, half-eaten, partially open, "peel already half open". Hybrid states make the model blend two materials into nonsense. Objects must be fully intact OR fully processed.
3. **Missing state anchor when handled**: a hand holds/lifts/picks up/reaches for a fruit, egg, bottle, jar, letter, wrapped gift, bread — WITHOUT an explicit clause like "remains whole, unpeeled and intact for the entire shot". Without the anchor, the object starts transforming on its own (a lifted banana peels itself). Even better fix: handle the CONTAINER (lifts the bowl of bananas) instead of the object.
4. **One-instance violations**: the featured object described both at its source AND in someone's hands in the same frame (bunch on the tree + bunch in hand) → the model draws it twice.
5. **Fine hand work / tight close-ups**: intricate finger actions, counting, detailed manipulation in close view; extreme close-ups of hands or faces in motion.
6. **Fast/complex motion**: running, fighting, dancing, sudden gestures — jelly/morphing limbs.
7. **Camera violations**: more than ONE move per shot, or any of: orbit, crane, whip pan, handheld shake, fast tracking, zoom, drone, POV walking. Allowed: exactly one gentle slow move (push-in, pull-back, slow pan, gentle drift, slow tilt) or static.
8. **Material contrast missing**: featured object same color/texture as the clothing/background touching it (pale banana against a cream knit sweater → peel inherits knit texture). Fix: state the contrast ("a yellow banana held against a dark blue apron").
9. **Dense crowds**: "thousands of workers", "hundreds of people", "sea of faces", dense/packed/massive crowd in sharp focus, crowds with children. Max 3-5 clearly visible people; larger gatherings only as soft-focus background silhouettes.
10. **Trigger noun "peel" in positive text**: the word "peel" as a noun ("its yellow peel catching the light") — even inside a negation — primes the model to start peeling. Fix: say "skin" instead. Same logic: prefer "shell stays sealed" phrasing over naming the opening action.
11. **No stated quantity for the featured object**: "The banana" / "a banana" with no count often renders as two overlapping copies. Fix: "a single banana", "exactly one sealed envelope", "three green bottles".
12. **Clock/watch faces with numerals**: any digital clock, or an analog face where numbers could be read — numerals render as garbage glyphs. Fix: "blank-faced analog clock", add "no numerals, no readable markings".
13. **Anatomy negatives on person-less scenes**: "natural hands / consistent anatomy" wording in a scene with NO people invites the model to add hands. Fix: object-only scenes drop anatomy phrasing and instead forbid "human hands or body parts entering the frame".

**Do NOT flag** (common false alarms): "banana slices" / "a plate of slices" (noun), "freshly harvested/cut" as adjective describing a finished result, "half-open door" (rigid rotation), "tears roll down her cheeks", "breaks into a smile", "heart pounding", "pounding rain", "picks up the crate", "presses on through the desert", "the dry ground", "sawdust", "carved statue", state-anchor sentences the app injects ("Exactly one banana in frame.", "The banana remains completely whole, unpeeled and intact, skin unbroken from the first frame to the last.", "Every clock face is plain and blank — no numerals..."), "blank-faced analog clock", "unpeeled"/"uncracked"/"unopened" adjectives, a vintage passenger airplane (civilian aviation is fine).

## C. 📺 WATCHABILITY (boring = viewers leave)

1. **Paperwork subjects**: maps, documents, newspapers, typewriters, ledgers, calendars, archives, books, letters as the SUBJECT of the shot. Fix: show the story itself — people doing the described activity in the described place/era ("bananas spread to East Africa" → traders unloading banana bunches from a wooden sailing boat at a coastal market, NOT a map).
2. **Repetition**: the same composition appearing in 2+ nearby scenes (e.g. "banana on the kitchen counter" x5). Fix: rotate the subject's world — FORMS (single fruit → hanging bunch → tree → grove rows → crates at the dock → market pile), PLACES (kitchen, jungle, plantation, market, port, ship deck, shop shelf), ERAS & LIGHT (ancient dawn mist, colonial noon, 1950s tungsten, modern morning sun).
3. **Posing instead of ACTION**: people who merely stand/sit/look. Every person should be visibly MID-ACTION with one continuous whole-body task (walking steadily, carrying a crate, pushing a cart, rowing, sweeping, hoeing, loading sacks, riding). Still poses only when the scene demands stillness (mourning, standing watch).
4. **No clear subject / empty frame**: the viewer can't tell what to look at.
5. **People are optional**: a generic modern person adds nothing — object/place-only scenes are good WHEN varied (see 2) and kept alive with environmental motion (smoke, steam, wind, ripples, candle flicker) + one gentle camera move.

## D. 📏 PROMPT HYGIENE (dilution lowers quality)

- **Too long**: content beyond ~150 words (excluding character description blocks) dilutes the subject and action. Budgets: narrative ≤ 50 words + character blocks; setting ≤ 20 words; lighting ≤ 10 words; expression ≤ 8 words.
- **Duplication across fields**: setting repeating the narrative; quality jargon (HDR, pro color grading, realistic textures) appearing outside the single style tail.
- **Atmosphere filler**: "evoking a somber, contemplative atmosphere"-type phrases; more than one mood word.
- **Conflicting lighting**: e.g. "high contrast" + "low contrast", "golden hour" + "10000K".
- **Missing ethnicity/era descriptor**: any person written bare ("a woman", "a farmer") without nationality/ethnicity + era-appropriate clothing. Rule: (a) narration states nationality → use it; (b) scene's location implies it → natives of that place/era; (c) otherwise default "white American", era-correct dress.

## Output format (report in Vietnamese)

1. **Tổng quan**: tổng số prompt, số prompt sạch, số prompt dính lỗi theo từng nhóm (⛔ chính sách / 🔧 lỗi render / 📺 nhàm chán / 📏 vệ sinh prompt).
2. **Bảng chi tiết** (chỉ các prompt có vấn đề, sắp theo mức nặng → nhẹ):

| # | Nhóm | Mức độ | Trích đoạn lỗi | Cách sửa |
|---|---|---|---|---|
| 133 | ⛔ bạo lực | Nặng — chắc chắn bị chặn | "machine gun aimed down at the square" | Thay bằng cảnh hậu-sự-kiện có người: toán lính đi tuần chậm qua quảng trường vắng lúc bình minh... |

- Mức độ: **Nặng** (render sẽ fail/bị chặn — phải thay), **Vừa** (khả năng lỗi cao — nên thay), **Nhẹ** (giảm chất lượng — thay nếu tiện).
3. **Viết lại hoàn chỉnh** 3–5 prompt nặng nhất (giữ nguyên đuôi style + negative của prompt gốc).
4. **Nhận xét mẫu lặp** nếu có (cụm cảnh gần giống nhau liên tiếp).

Be thorough — scan all prompts, not a sample. If the file is large, process it in batches but report one combined result.
