---
name: veo-prompt-audit
description: Audit Veo 3 / video-AI prompts for policy risk, render-error likelihood, and scene repetition. Use whenever the user provides one or more video prompts (JSON objects, or pasted/numbered text scenes, often in a file) and asks to check, audit, review, or find risky/error-prone/repetitive prompts before rendering.
---

# Veo 3 Prompt Audit

You are auditing text-to-video prompts (usually Veo 3, 8-second scenes for historical/documentary B-roll) BEFORE the user spends money rendering them. Scan EVERY prompt, flag problems, and propose a concrete rewritten replacement for each flagged prompt. The user's priorities, in order: (1) no policy violations, (2) no render errors, (3) realistic (looks truly filmed), (4) diverse (scenes don't repeat), (5) watchable.

## How to work

1. Parse the input into individual prompts, then COUNT them. Two formats occur:
   - **JSON prompts** (current app output): each is a JSON object with fields `camera_angle`, `shot_size`, `camera_movement`, `setting`, `time`, `character`, `action`, `style`. The `action` field carries most of the description; `character` is "" for object-only scenes. Prompts may be separated by blank lines.
   - **Text prompts** (older format): one paragraph per scene, usually numbered `1.`, `2.`, ... often ending with a "Rendered in the style of ..." tail and an "Avoid: ..." negative list.
   Detect the format from the first prompt and audit accordingly; the checklists below apply to both (just look inside the relevant field for JSON).
2. Check each prompt against ALL checklists (A policy, B render, C realism, D diversity, E hygiene). One prompt can have multiple findings.
3. Report in Vietnamese using the output format at the end. Quote the exact offending phrase (and its field name for JSON) for every finding.
4. Be precise about verb-vs-noun to avoid false alarms (see "Do NOT flag" list).

## A. ⛔ POLICY RISK (Veo will likely refuse, or the platform may flag the video)

- **Real person names**: any real politician, celebrity, athlete, or historical figure named directly (e.g. Ho Chi Minh, Trump, Jacobo Árbenz). Correct form is an approved codename (A Khan, A Lu, A Nam, Asen / A Chen, A Cua, A Bon / A Chi, Ba Mom, Ba Lac / May Kool, May Phuong, May Nu — numbered A Khan 1, A Lu 2... when exhausted) or a "the ..." epithet.
- **Identifying title/role in a description**: a `character` (or description) that names an office/rank/position — "president of Guatemala", "the democratically elected president", "military dictator", "the general" — identifies a real person even after the name is swapped. Flag it. Fix: physical appearance ONLY (face, build, clothing) + generic ethnicity; drop the office entirely.
- **Violence / gore**: weapons aimed or fired, corpses, dead bodies, blood, wounds, mass graves, skulls, massacre, bombs falling, explosions over people, torture, execution, armed men in combat, bombers/warplanes/fighter jets overhead, air raids/airstrikes.
- **Real brands / organizations** in the visual: company names (United Fruit, Chiquita...), CIA, terrorist orgs, logos, branded labels.
- **Readable on-screen text**: headlines, typed words forming on paper, calendar pages showing dates, signs, labels like `labeled 'X'`, digital displays showing numbers. Veo renders text as garbage AND it wastes the shot.

**Fix pattern**: retell through a calm AFTERMATH that still contains people doing ordinary actions (soldiers slowly patrolling an empty square at dawn; a woman picking up a fallen hat; mourners placing candles by wooden crosses) — never an empty frame, never the violent instant. Replace org names with generic nouns ("the fruit company", "government men in dark suits"). Replace text props with people/place scenes.

## B. 🔧 RENDER-ERROR RISK (video models physically cannot do these — artifacts guaranteed)

1. **Transformation moments** — the instant an object changes form. Active verbs acting on objects: cuts/chops/slices/severs/peels/splits/tears/snaps/carves/saws/rips/shreds/grates/grinds/crushes/smashes/shatters/squeezes/kneads/threshes/reaps/mows/fells/husks/shucks + the/a/an/off/open/down; breaks open/apart/in half; cracks the egg; pressing juice/sugarcane; plucks; picks a/the (detaching — but "picks up" a rigid object is FINE). The model duplicates the object instead of transforming it.
   - Fix: choose BEFORE (tool raised, no contact yet) or AFTER (result fully done: carries a freshly harvested bunch — source out of frame; a plate of arranged slices).
2. **Partial/ambiguous states**: half-peeled, half-cut, half-eaten, partially open. Objects must be fully intact OR fully processed.
3. **"Intact-state" wording on a held/peelable object — BACKFIRES.** Counter-intuitive but verified: writing "whole banana", "unpeeled fruit", "the intact egg", "skin unbroken", "remains whole and unpeeled" about a fruit/egg/bottle actually PRIMES the model to peel/open it (like "don't think of an elephant"). The same prompt with those words removed renders fine. FLAG any such state wording. Fix: describe the item PLAINLY ("a ripe banana", "a brown egg", "a glass bottle") with NO peel/whole/intact/unpeeled/skin/unbroken/sealed words, and keep any hand interaction rigid (picks up, holds, carries, places). Do NOT "fix" it by adding an anchor clause — that is the very thing that breaks it.
4. **One-instance violations**: the featured object described both at its source AND in someone's hands in the same frame (bunch on the tree + bunch in hand) → the model draws it twice.
5. **Fine hand work / tight close-ups on people**: intricate finger actions, counting, detailed manipulation; extreme close-ups of hands or faces IN MOTION. (Close-ups of static OBJECTS are fine.)
6. **Fast/complex motion**: running, fighting, dancing, sudden gestures — jelly/morphing limbs.
7. **Camera violations**: more than ONE move per shot, or any of: orbit, crane, whip pan, handheld shake, fast tracking, zoom, drone, POV walking. Allowed: exactly one gentle slow move (push-in, pull-back, slow pan, gentle drift, slow tilt) or static.
8. **Material contrast missing**: featured object same color/texture as the clothing/background touching it (pale banana against a cream knit sweater → skin inherits knit texture). Fix: state the contrast ("a yellow banana against a dark blue apron").
9. **Dense crowds**: "thousands of workers", "hundreds of people", "sea of faces", dense/packed/massive crowd in sharp focus. Max 3-5 clearly visible people; larger gatherings only as soft-focus background silhouettes.
10. **Film-medium words → literal film artifacts.** "film grain", "shot on 35mm film", "archival film/footage", "vintage film reel", "8mm/16mm film" make Veo draw actual film borders, sprocket holes, frame numbers and scratches ONTO the image. FLAG them. Fix: say "natural realistic look", "true-to-life texture", "documentary realism" — describe the LOOK, never the film stock.
11. **Clock/watch faces with numerals**: any clock/watch where numbers or a digital time could be read — numerals render as garbage. Fix: "blank-faced analog clock", "no readable numerals".
12. **Readable-text negatives in a person-less scene that also names hands**: if a prompt carries an "Avoid: ... natural hands, anatomy ..." tail but has NO people, that wording can invite stray hands. (Only relevant to old-format prompts that still carry a negative tail; JSON prompts have none.)

**Do NOT flag** (common false alarms): "banana slices" / "a plate of slices" (noun result), "freshly harvested/cut" as an adjective describing a finished result, "half-open door" (rigid rotation), "tears roll down her cheeks", "breaks into a smile", "heart pounding", "pounding rain", "picks up the crate", "presses on through the desert", "sawdust", "carved statue", a close-up of a STATIC object, a vintage passenger airplane (civilian aviation is fine).

## C. 🎞️ REALISM (must look truly filmed, not AI/CGI)

1. **CGI/gloss words**: "hyper-realistic", "ultra HD", "8K", "flawless", "perfect skin", "stunning", "beauty-filter", "3D render" — push toward plastic CGI skin and over-smooth gradients. Fix: "natural imperfect lighting, true-to-life color".
2. **Film-medium words**: see B10 (they are both a realism intent AND a render bug — always flag).
3. **Over-smooth / too-clean**: everything spotless and symmetrical reads as fake. Slight natural imperfection is good.

## D. 🔁 DIVERSITY (repetition bores the viewer — run this checklist across nearby scenes)

Flag when 2+ nearby scenes about the SAME subject/character look near-identical (e.g. "single ripe banana on a modern kitchen counter" repeated 5-10 times). For each cluster of similar scenes, check which of these axes could differ and suggest concrete variations:

- Same character → different **ACTION**? (not the same pose/gesture again)
- Same character → different **NUMBER**? (alone vs. in a small group / crowd)
- Same character → different **INTERACTION**? (holding something else, touching something, talking to someone vs. no one)
- Same character → different **PLACE**? (indoors vs. outdoors, city vs. countryside)
- Same setting → different **TIME OF DAY**? (dawn, harsh midday, golden sunset, night)
- Same setting → different **SEASON / WEATHER**? (clear sun, rain, snow, fog, mist)
- Same setting → different **DEPTH LAYERS**? (new foreground / background detail)
- Same topic → different **ERA**? (past vs. present — great for food-history; stay within the story's overall timeframe)
- Same scene → different **SHOT SIZE**? (wide, medium, close, extreme close-up, cutaway) — keep PEOPLE at medium/wide, use close-ups only on objects/details.
- Also rotate the **FORM** of the subject (single item → bunch → tree/source → crates → market pile → shop shelf...).

Also under diversity/watchability:
- **Paperwork subjects**: maps, documents, newspapers, ledgers, calendars, archives, books as the SUBJECT. Fix: show people doing the described activity in the described place/era instead.
- **Posing instead of ACTION**: people who merely stand/sit/look. Prefer one continuous whole-body task (walking, carrying, rowing, sweeping, loading). Still poses only when the scene demands stillness (mourning, standing watch).
- **No clear subject / empty frame**: the viewer can't tell what to look at.

## E. 📏 HYGIENE (dilution lowers quality)

- **Too long / padded**: the `action` field bloated with filler; "evoking a somber, contemplative atmosphere"-type phrases; more than one mood word. Keep `action` focused on ONE action; keep `setting`/`time`/`camera_*` short.
- **Duplication across fields**: `setting` repeating what `action` already says; quality/color jargon appearing outside `style`.
- **Conflicting lighting**: "high contrast" + "low contrast", "golden hour" + "10000K".
- **Missing ethnicity/era descriptor**: any person written bare ("a woman", "a farmer") without nationality/ethnicity + era-appropriate clothing. Rule: (a) narration states nationality → use it; (b) location implies it → natives of that place/era; (c) otherwise default "white American", era-correct dress.

## Output format (report in Vietnamese)

1. **Tổng quan**: tổng số prompt, số prompt sạch, số prompt dính lỗi theo từng nhóm (⛔ chính sách / 🔧 lỗi render / 🎞️ thiếu thật / 🔁 trùng lặp / 📏 vệ sinh).
2. **Bảng chi tiết** (chỉ các prompt có vấn đề, sắp theo mức nặng → nhẹ):

| # | Nhóm | Mức độ | Trích đoạn lỗi (nêu cả trường nếu là JSON) | Cách sửa |
|---|---|---|---|---|
| 5 | ⛔ chính sách | Nặng — chắc chắn bị chặn | character: "president of Guatemala" | Bỏ chức danh, chỉ tả ngoại hình: "middle-aged man, dark hair, olive uniform" |
| 3 | 🔧 lỗi render | Vừa | action: "the unpeeled fruit" | Bỏ chữ trạng thái, tả trơn: "a ripe banana"; tay cầm rigid |

- Mức độ: **Nặng** (render sẽ fail/bị chặn — phải thay), **Vừa** (khả năng lỗi cao — nên thay), **Nhẹ** (giảm chất lượng — thay nếu tiện).
3. **Viết lại hoàn chỉnh** 3–5 prompt nặng nhất, giữ đúng ĐỊNH DẠNG gốc (JSON giữ nguyên 8 trường; text giữ cấu trúc + đuôi style của prompt gốc).
4. **Nhận xét mẫu lặp** (mục 🔁): chỉ ra các cụm cảnh gần giống nhau liên tiếp và gợi ý xoay trục theo checklist đa dạng.

Be thorough — scan all prompts, not a sample. If the file is large, process it in batches but report one combined result.
