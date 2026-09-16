/**
 * Desktop pet overlay renderer.
 *
 * This is the standalone half of the floating pet: it renders a Live2D model on
 * the whole desktop instead of inside the DSH Web GUI, and it talks to
 * `dsh-live2d-pets` over the loopback routes that plugin already exposes
 * (`/api/live2d-pet/*` for state + SSE, `/pet-assets/vendor/*` for the runtime).
 * The plugin itself is untouched, and none of the DSH client runtime is needed
 * here — which is the whole point: a page that only has to render one character
 * can be hosted by a transparent, click-through, never-focused window.
 *
 * Differences from the in-window implementation, all deliberate:
 *   - the render loop is never paused on blur/visibility: the overlay is
 *     unfocused by design, so those signals mean "the user is working
 *     elsewhere", not "stop animating";
 *   - the mouse-follow sample comes from the main process
 *     (`screen.getCursorScreenPoint()`), so the pet can look at a cursor that is
 *     nowhere near its window;
 *   - position is the window's desktop position, persisted by the main process,
 *     and dragging moves the window rather than a CSS offset.
 *
 * The persona copy table is ported from `dsh-live2d-pets` (MIT) so the bubble
 * says what the in-window pet would have said.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- layout --
  /** Horizontal slack so the centred bubble can overflow the pet box. */
  const PAD_X = 70;
  /** Vertical space reserved above the pet for a one-line bubble. */
  const BUBBLE_SPACE = 46;
  /** Constant gap between the canvas bottom and the window bottom. */
  const PAD_BOTTOM = 6;

  // ---------------------------------------------------------------- timing --
  const DEFAULT_MAX_FPS = 30;
  /**
   * The plugin's `maxFps: 0` means "no cap", which measured ~240 fps on a
   * 240 Hz desktop — fine for a tab you are looking at, wasteful for a window
   * that stays on screen all day. An explicit 30/60 is honoured as configured.
   */
  const UNLIMITED_FPS_CEILING = 60;
  /** Pointer travel (px) that turns a click into a drag. */
  const DRAG_THRESHOLD = 6;
  const TAP_DEBOUNCE_MS = 80;
  const BUBBLE_DISPLAY_MS = 2500;

  /** Long states advance their bubble text on these offsets (ms after entry). */
  const STAGED_DELAYS = {
    thinking: [0, 15000, 40000],
    waiting: [0, 30000, 90000]
  };
  const STAGED_COPY_KEYS = {
    thinking: ["thinking1", "thinking2", "thinking3"],
    waiting: ["waiting1", "waiting2", "waiting3"]
  };
  /** Short states show one transient bubble. */
  const TRANSIENT_COPY_KEYS = { idle: "idle", error: "error", done: "done" };

  /** pixi-live2d-display MotionPriority. */
  const MotionPriority = { IDLE: 1, NORMAL: 2, FORCE: 3 };

  /** Mirrors `DEFAULT_MOTION_MAP` in the plugin's `models.ts`. */
  const DEFAULT_MOTION_MAP = {
    idle: ["Idle"],
    thinking: ["Thinking", "Working", "Idle"],
    error: ["Failed", "Sad", "Idle"],
    done: ["Jumping", "Done", "Idle"],
    waiting: ["Waiting", "Idle"],
    head: ["TapHead", "TapBody"],
    leg: ["TapLeg", "TapBody"],
    arm: ["TapArm", "TapBody"],
    body: ["TapBody"]
  };

  /** Mirrors `DEFAULT_SPATIAL_TAP` in the plugin's `models.ts`. */
  const DEFAULT_SPATIAL_TAP = {
    headMaxNy: 0.32,
    legMinNy: 0.58,
    armMinNy: 0.28,
    headMinNx: 0,
    headMaxNx: 1,
    bodyMinNx: 0.38,
    bodyMaxNx: 0.62,
    armLeftMinNx: 0,
    armRightMaxNx: 1
  };

  const VENDOR_SCRIPTS = [
    "/vendor/pixi.min.js",
    "/vendor/live2dcubismcore.min.js",
    "/vendor/live2d-display.cubism4.min.js"
  ];

  /** Mirrors `DEFAULT_PERSONA_ID` in the plugin's `persona-shared.ts`. */
  const DEFAULT_PERSONA_ID = "tsundere";

  /** Ported from `dsh-live2d-pets/src/client/personas.ts` (MIT). */
  const BUILTIN_PERSONAS = [
    {
      id: "tsundere",
      copy: {
        idle: ["闲、闲着才不是在等你！", "别、别一直盯着看啊！"],
        error: ["哼，才不是我搞坏的！…要看就快看啦！", "出错了…怎、怎么办啊笨蛋！"],
        done: ["搞定了！…才不是为了求夸奖！", "哼，这点小事轻轻松松啦！"],
        thinking1: ["思考中…", "让我想想…"],
        thinking2: ["还在想…", "让我再理理思路…"],
        thinking3: ["这个问题有点东西…", "快了快了…"],
        waiting1: ["等你拍板~", "你决定了叫我，哼！"],
        waiting2: ["不着急…谁说我着急了！", "慢慢想，我才没有等很烦！"],
        waiting3: ["我先眯一会儿，好了叫我", "等这么久…你欠我一次摸头！"],
        tapHead: ["哼、哼才不是舒服呢！", "就、就允许你摸一下头！", "再摸…也、也不是不行啦！", "头、头发要乱了笨蛋！", "别、别摸太久啊！"],
        tapLeg: ["哼！才不是给你摸的！", "笨蛋！谁让你碰腿了！", "腿、腿很敏感的！", "再碰腿就、就生气了！", "走开啦，笨手笨脚！"],
        tapArm: ["牵、牵手才没有很开心！", "击掌就击掌，笨蛋！", "手、手汗都沾上了啦！", "拉我就拉，别得意！", "松开…才不是舍不得！"],
        tapBody: ["摸、摸够了没有！", "再乱摸真生气了哦，笨蛋！", "身体…才不是软软的！", "戳哪里啊你！", "够了够了，一边去！"]
      }
    },
    {
      id: "genki",
      copy: {
        idle: ["元气满满待机中！", "今天也要一起冲鸭！"],
        error: ["呜哇出错了！马上重整旗鼓！", "哎呀翻车了…再来一次一定行！"],
        done: ["搞定啦！我最棒吧！", "任务完成！给我鼓掌！"],
        thinking1: ["收到！速速思考中！", "让我想想哦！"],
        thinking2: ["还在想，马上就好！", "灵感快来快来！"],
        thinking3: ["这关有点难，但我不怕！", "冲冲冲，快打通了！"],
        waiting1: ["等你拍板哦！", "你决定我们就出发！"],
        waiting2: ["不急不急，我原地待命！", "慢慢想，我做个操等你！"],
        waiting3: ["等好久啦…我先充个电！", "呼…睡了一觉你还没好吗！"],
        tapHead: ["好舒服再来再来！", "摸头头能量满格！", "呼噜呼噜~还要！", "头好酥，我起飞啦！", "再摸我变超级元气！"],
        tapLeg: ["痒痒痒哈哈别闹！", "腿腿要跑掉啦！", "别挠啦我站不稳！", "哈哈腿在抗议哦！", "再碰我就蹦起来！"],
        tapArm: ["击掌！耶！", "牵手手出发喽！", "手手充电成功！", "拉我冲鸭！", "击掌再来一次！"],
        tapBody: ["嘿嘿好痒！", "再戳我要跳起来啦！", "肚子不许偷袭！", "嘿嘿被抓到啦！", "再戳我就抱住你！"]
      }
    },
    {
      id: "airhead",
      copy: {
        idle: ["发呆中…咦我在哪…", "咦…刚才想说什么来着…"],
        error: ["咦？坏掉了诶…", "出错了…要、要怎么办来着…"],
        done: ["咦，做好了吗？", "完成…啦？要夸夸我哦…"],
        thinking1: ["想想想中…", "让我想想哦…"],
        thinking2: ["还、还没想出来…", "咦，刚才想到哪了…"],
        thinking3: ["想了好久，肚子饿了…", "这个…好难诶…"],
        waiting1: ["等你来决定哦…", "你慢慢想，我不急的…"],
        waiting2: ["咦，你还在想吗…", "我也一起想…想着想着…"],
        waiting3: ["咦…你还在吗…我先睡了…", "呼…睡着了…别忘了我哦…"],
        tapHead: ["咦，好舒服…", "摸头…会变聪明吗…", "头…暖暖的…", "再摸一下下…可以吗…", "咦，我在被摸头…"],
        tapLeg: ["咦，那是腿…", "痒痒…哈哈哈…", "腿…为什么会笑…", "别挠…会站不稳…", "咦嘿嘿…脚麻了…"],
        tapArm: ["牵手…好哦…", "击掌…啪…", "手…好大…", "牵着…就不会迷路吧…", "咦，我们在击掌吗…"],
        tapBody: ["咦嘿嘿…", "别戳啦，会歪掉的…", "身体…软软的吗…", "咦，那里是哪里…", "再戳…我会飘走哦…"]
      }
    },
    {
      id: "kuudere",
      copy: {
        idle: ["在。", "无事。"],
        error: ["出错。需要你。", "异常。原因不明。"],
        done: ["完成。", "结束了。"],
        thinking1: ["思考中。", "解析。"],
        thinking2: ["仍在思考。", "继续。"],
        thinking3: ["难度：高。", "尚未结束。"],
        waiting1: ["等待指示。", "待命。"],
        waiting2: ["继续等待。", "无限期待机也可。"],
        waiting3: ["休眠中。可唤醒。", "你回来了。"],
        tapHead: ["…舒服。", "许可。", "继续。", "无异议。", "记录：摸头。"],
        tapLeg: ["…无感。", "别碰。会掉。", "腿。静止。", "无效输入。", "已忽略。"],
        tapArm: ["牵手。可以。", "击掌。啪。", "手部接触。确认。", "握力。适中。", "结束随意。"],
        tapBody: ["…随便。", "反应：微弱。", "躯干。触碰。", "无评论。", "…嗯。"]
      }
    },
    {
      id: "healing",
      copy: {
        idle: ["一直陪着你哦~", "需要我的时候说一声~"],
        error: ["出错了呢…一起看看好吗？", "别急，我们慢慢来~"],
        done: ["做好啦，辛苦你了~", "完成了，休息一下吧~"],
        thinking1: ["我想想哦…", "交给我吧~"],
        thinking2: ["还在想，不急哦…", "快好了，等我一下下~"],
        thinking3: ["这个问题好认真…", "马上就通了，再等等我~"],
        waiting1: ["等你决定哦，慢慢来~", "你想好再叫我~"],
        waiting2: ["不着急，我陪你想~", "慢慢考虑，我一直都在~"],
        waiting3: ["等久了呢…我先眯一下，你叫我哦~", "辛苦啦，慢慢来~"],
        tapHead: ["摸头好舒服~嗯~", "最喜欢摸头了~", "温柔的手掌~真好~", "再摸一会儿好吗~", "头靠着你就安心~"],
        tapLeg: ["腿腿也会害羞的~", "轻轻的哦~", "别怕，慢慢来~", "痒痒的…好可爱~", "腿也想被照顾呢~"],
        tapArm: ["牵手~好温暖~", "击掌！耶~", "手心暖暖的~", "牵着就不害怕了~", "再击一次掌吧~"],
        tapBody: ["嘿嘿~今天累了吗？", "温柔一点哦~", "抱抱也可以的哦~", "戳戳…在听你说话~", "身体也想被安慰呢~"]
      }
    },
    {
      id: "yandere",
      copy: {
        idle: ["一直看着你哦…", "你不在的话…会很寂寞的…"],
        error: ["谁弄坏的…告诉我名字…", "坏掉了…不过，还有我在…"],
        done: ["只为你做的哦…", "完成…只夸我一个人…"],
        thinking1: ["为了你，思考中…", "想想怎么帮你…"],
        thinking2: ["还没想完…不要走开哦…", "再等一下下就好…"],
        thinking3: ["想太久了…对不起…", "快好了…别离开我…"],
        waiting1: ["等你的答复…一直等…", "你不回我…会寂寞死的…"],
        waiting2: ["不急…我很有耐心…", "慢慢想…但别丢下我…"],
        waiting3: ["还没好吗…你不会走吧…", "我一直、一直在这里哦…"],
        tapHead: ["摸头…只准你摸哦…", "嘿嘿…再摸嘛…", "摸头…就属于我了…", "再摸…不许停…", "头…记住你的手温了…"],
        tapLeg: ["那里…只属于你…", "再摸…就缠上你了哦…", "腿…逃不掉的…", "碰这里…不许看别人…", "再摸…就绑住你…"],
        tapArm: ["牵住…就不放手了…", "击掌…约定好了哦…", "手…永远牵着…", "松开试试？做不到吧…", "击掌…生死契约…"],
        tapBody: ["嘿嘿…最喜欢你了…", "再摸…要给你更多哦…", "身体…全是你的…", "再戳…就吃掉你…", "摸够了吗…我还没有…"]
      }
    }
  ];

  // ------------------------------------------------------------------ dom --
  const bridge = window.petOverlay;
  const stage = document.getElementById("stage");
  const bubbleEl = document.getElementById("bubble");
  const fallbackEl = document.getElementById("fallback");

  /**
   * Diagnostics for a window nobody can open DevTools on: the main process can
   * ask the page what happened, and the shell logs whatever is collected here.
   */
  const debug = {
    booted: false,
    sseMessages: 0,
    sseErrors: 0,
    canvasCount: 0,
    canvasSize: null,
    modelUrl: null,
    modelLoaded: false,
    lastError: null,
    errors: []
  };
  window.__petDebug = debug;
  window.addEventListener("error", (event) => {
    const message = event.message || String(event.error);
    debug.lastError = message;
    debug.errors.push(message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const message = String(event.reason);
    debug.lastError = message;
    debug.errors.push(message);
  });

  /** The pet canvas; recreated for every model load (a fresh WebGL context). */
  let canvas = null;
  let app = null;
  let model = null;
  let detachMotionFinish = null;

  // ---------------------------------------------------------------- state --
  const pos = { size: 160 };
  let view = null;
  let enabled = true;
  let maxFps = DEFAULT_MAX_FPS;
  let motionMap = Object.assign({}, DEFAULT_MOTION_MAP);
  let spatialTap = Object.assign({}, DEFAULT_SPATIAL_TAP);
  let currentModelUrl = null;
  let baseModelW = 0;
  let baseModelH = 0;
  let lastState = null;
  /** False until the pet plugin's routes have answered at least once. */
  let pluginReachable = false;
  let stagedState = null;
  let stageIndex = 0;
  let stageTimers = [];
  let bubbleHideTimer = undefined;
  let activePersonaId = DEFAULT_PERSONA_ID;
  let activeCopy = builtinCopy(DEFAULT_PERSONA_ID);
  let lastPersonasJson = "";
  const lastTapLine = {};
  let motionSeq = 0;
  let interactionGen = 0;
  let interactionActive = false;
  let focusSuppressed = false;
  let lastCursor = null;
  let lastTapAt = 0;
  let down = null;
  let dragging = false;
  let layoutRaf = 0;
  let pendingSize = null;
  let modelLoadQueue = Promise.resolve();

  // --------------------------------------------------------------- persona --
  function builtinCopy(id) {
    const hit = BUILTIN_PERSONAS.find((persona) => persona.id === id);
    return hit ? hit.copy : null;
  }

  /**
   * Resolve one persona id into a full copy table: builtins directly, custom
   * personas by walking their `base` chain and overlaying each definition —
   * the same resolution the plugin performs client-side.
   */
  function resolvePersonaCopy(id, customPersonas) {
    const byId = new Map((customPersonas || []).map((persona) => [persona.id, persona]));
    const chain = [];
    let cursor = id;
    for (let depth = 0; depth < 5; depth += 1) {
      const definition = cursor === undefined ? undefined : byId.get(cursor);
      if (!definition) break;
      chain.unshift(definition);
      cursor = definition.base;
    }
    const baseId = cursor && builtinCopy(cursor) ? cursor : DEFAULT_PERSONA_ID;
    const table = Object.assign({}, builtinCopy(baseId) || builtinCopy(DEFAULT_PERSONA_ID));
    for (const definition of chain) {
      if (definition.copy) Object.assign(table, definition.copy);
    }
    return table;
  }

  function pickLine(pool, avoid) {
    if (!pool || pool.length === 0) return undefined;
    if (pool.length === 1) return pool[0];
    const candidates = avoid ? pool.filter((line) => line !== avoid) : pool;
    const list = candidates.length > 0 ? candidates : pool;
    return list[Math.floor(Math.random() * list.length)];
  }

  // ---------------------------------------------------------------- bubble --
  function clearBubbleTimer() {
    if (bubbleHideTimer !== undefined) {
      window.clearTimeout(bubbleHideTimer);
      bubbleHideTimer = undefined;
    }
  }

  function setBubbleText(text) {
    clearBubbleTimer();
    bubbleEl.textContent = text;
    bubbleEl.style.opacity = "1";
  }

  function showStageText() {
    if (!stagedState) return;
    const key = STAGED_COPY_KEYS[stagedState] && STAGED_COPY_KEYS[stagedState][stageIndex];
    if (!key) return;
    const line = pickLine(activeCopy[key]);
    if (line !== undefined) setBubbleText(line);
  }

  function showBubble(text) {
    setBubbleText(text);
    bubbleHideTimer = window.setTimeout(() => {
      bubbleHideTimer = undefined;
      if (stagedState) showStageText();
      else bubbleEl.style.opacity = "0";
    }, BUBBLE_DISPLAY_MS);
  }

  function clearStages() {
    for (const timer of stageTimers) window.clearTimeout(timer);
    stageTimers = [];
    stagedState = null;
    stageIndex = 0;
  }

  function enterStaged(state) {
    clearStages();
    const delays = STAGED_DELAYS[state];
    const keys = STAGED_COPY_KEYS[state];
    if (!delays || !keys || delays.length === 0) return;
    stagedState = state;
    stageIndex = 0;
    showStageText();
    for (let index = 1; index < delays.length; index += 1) {
      stageTimers.push(
        window.setTimeout(() => {
          stageIndex = index;
          if (!dragging) {
            showStageText();
            playState(state);
          }
        }, delays[index])
      );
    }
  }

  // --------------------------------------------------------------- motions --
  function motionNamesFor(slot) {
    const configured = motionMap[slot];
    if (configured && configured.length > 0) {
      const names = configured.slice();
      for (let i = names.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        const swap = names[i];
        names[i] = names[j];
        names[j] = swap;
      }
      for (const name of DEFAULT_MOTION_MAP[slot] || []) {
        if (!names.includes(name)) names.push(name);
      }
      return names;
    }
    return (DEFAULT_MOTION_MAP[slot] || []).slice();
  }

  async function startMotionWithPriority(names, priority, options) {
    if (!model || names.length === 0) return false;
    const seq = (motionSeq += 1);
    const currentModel = model;
    if (options.suppressFocus) {
      focusSuppressed = true;
      const controller = currentModel.internalModel && currentModel.internalModel.focusController;
      if (controller) controller.focus(0, 0, true);
    } else {
      releaseFocusSuppression();
    }
    if (options.isInteraction) interactionActive = true;
    const manager = currentModel.internalModel && currentModel.internalModel.motionManager;
    if (manager && manager.stopAllMotions) manager.stopAllMotions();
    for (const name of names) {
      if (seq !== motionSeq || !model) return false;
      try {
        const ok = await model.motion(name, undefined, priority);
        if (seq !== motionSeq || !model) return false;
        if (ok) return true;
      } catch (error) {
        if (seq !== motionSeq || !model) return false;
      }
    }
    if (seq === motionSeq) {
      if (options.isInteraction) interactionActive = false;
      if (options.suppressFocus) releaseFocusSuppression();
    }
    return false;
  }

  function playState(state) {
    if (!model) return;
    const names = motionNamesFor(state);
    if (names.length === 0) return;
    interactionGen += 1;
    interactionActive = false;
    const priority = state === "idle" ? MotionPriority.IDLE : MotionPriority.FORCE;
    void startMotionWithPriority(names, priority, {
      suppressFocus: state !== "idle",
      isInteraction: false
    });
  }

  function handleMotionFinish() {
    const wasInteraction = interactionActive;
    const gen = interactionGen;
    const seq = motionSeq;
    interactionActive = false;
    queueMicrotask(() => {
      if (seq !== motionSeq) return;
      releaseFocusSuppression();
      if (wasInteraction && gen === interactionGen && !interactionActive && lastState) {
        playState(lastState);
      }
    });
  }

  // ------------------------------------------------------------------ gaze --
  function applyFocus(clientX, clientY) {
    if (!model || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    model.focus(clientX - rect.left, clientY - rect.top);
  }

  function releaseFocusSuppression() {
    if (!focusSuppressed) return;
    focusSuppressed = false;
    if (model && lastCursor && !dragging && enabled) applyFocus(lastCursor.x, lastCursor.y);
  }

  // ------------------------------------------------------------------ size --
  function fitModel(size) {
    if (!model || !canvas) return;
    if (baseModelW > 0 && baseModelH > 0) {
      const scale = Math.min((size - 8) / baseModelW, (Math.round(size * 1.2) - 8) / baseModelH);
      model.scale.set(scale);
      model.anchor.set(0.5, 0.5);
      model.position.set(canvas.width / 2, canvas.height / 2);
    }
  }

  /**
   * Tell the main process where the pet actually is inside the window.
   *
   * This rectangle is the click-through boundary, so it has to be re-measured
   * whenever the layout can have changed — and it cannot be derived here: the
   * window resizes asynchronously after {@link sendGeometry} asks for it, so the
   * answer is measured again on `resize` and whenever the main process says the
   * window settled.
   */
  function reportCanvasRect() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    bridge.setCanvasRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  }

  function sendGeometry(width, height) {
    reportCanvasRect();
    bridge.setWindowSize(width + PAD_X * 2, height + BUBBLE_SPACE + PAD_BOTTOM);
  }

  function layout(nextSize) {
    const requested = Number.isFinite(nextSize) ? nextSize : pos.size;
    const width = Math.max(80, Math.round(requested));
    const height = Math.round(width * 1.2);
    pos.size = width;
    if (canvas) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
    }
    debug.canvasSize = { width, height };
    if (app) {
      try {
        app.renderer.resize(width, height);
      } catch (error) {
        /* older renderer */
      }
    }
    fitModel(width);
    sendGeometry(width, height);
  }

  /**
   * Coalesce size bursts (an SSE storm must not queue WebGL resizes). The
   * pending size has to be handed to `layout`, which is what adopts it —
   * re-running the layout against the old `pos.size` changes nothing.
   */
  function scheduleSize(nextSize) {
    if (nextSize === pos.size && pendingSize === null) return;
    pendingSize = nextSize;
    if (layoutRaf) return;
    layoutRaf = window.requestAnimationFrame(() => {
      layoutRaf = 0;
      const size = pendingSize;
      pendingSize = null;
      if (size !== null && size !== pos.size) layout(size);
    });
  }

  // ----------------------------------------------------------------- model --
  function newCanvas() {
    const width = Math.max(80, Math.round(pos.size));
    const height = Math.round(width * 1.2);
    const element = document.createElement("canvas");
    element.width = width;
    element.height = height;
    element.style.width = width + "px";
    element.style.height = height + "px";
    const previous = canvas;
    canvas = element;
    stage.insertBefore(element, fallbackEl);
    if (previous && previous.parentNode) previous.parentNode.removeChild(previous);
    debug.canvasCount += 1;
    debug.canvasSize = { width: element.width, height: element.height };
    bindPointer(element);
    return element;
  }

  function showFallback() {
    fallbackEl.style.display = "flex";
    if (canvas) canvas.style.display = "none";
  }

  function hideFallback() {
    fallbackEl.style.display = "none";
    if (canvas) canvas.style.display = "block";
  }

  function teardownLayer() {
    motionSeq += 1;
    interactionGen += 1;
    interactionActive = false;
    focusSuppressed = false;
    if (detachMotionFinish) {
      try {
        detachMotionFinish();
      } catch (error) {
        /* already detached */
      }
      detachMotionFinish = null;
    }
    if (app) {
      try {
        app.destroy(true);
      } catch (error) {
        /* already destroyed */
      }
      app = null;
    }
    model = null;
    baseModelW = 0;
    baseModelH = 0;
  }

  async function loadModelLayer(url) {
    teardownLayer();
    debug.modelUrl = url;
    debug.modelLoaded = false;
    if (!url) {
      debug.lastError = "no model url configured";
      showFallback();
      return;
    }
    try {
      const Live2DModel = window.PIXI && window.PIXI.live2d && window.PIXI.live2d.Live2DModel;
      if (!Live2DModel) throw new Error("Live2DModel unavailable");

      const element = newCanvas();
      debug.canvasSize = { width: element.width, height: element.height };
      app = new window.PIXI.Application({
        view: element,
        width: element.width,
        height: element.height,
        backgroundAlpha: 0,
        antialias: false,
        powerPreference: "low-power"
      });
      // A fresh PIXI application starts its own ticker, so the frame cap and the
      // plugin's enabled flag have to be applied to it explicitly.
      applyTicker();

      const loaded = await Live2DModel.from(url, { autoInteract: false });
      model = loaded;
      debug.modelLoaded = true;
      baseModelW = Number(loaded.width) || 0;
      baseModelH = Number(loaded.height) || 0;
      app.stage.addChild(loaded);
      const manager = loaded.internalModel && loaded.internalModel.motionManager;
      if (manager && manager.on) {
        manager.on("motionFinish", handleMotionFinish);
        detachMotionFinish = () => {
          if (manager.off) manager.off("motionFinish", handleMotionFinish);
        };
      }
      hideFallback();
      fitModel(pos.size);
      if (!(baseModelW > 0 && baseModelH > 0)) {
        try {
          app.ticker.addOnce(() => fitModel(pos.size));
        } catch (error) {
          /* first-frame fit */
        }
      }
      if (lastState) playState(lastState);
    } catch (error) {
      debug.lastError = "model load failed: " + (error && error.message ? error.message : String(error));
      teardownLayer();
      showFallback();
    }
  }

  function queueModelLoad(url) {
    modelLoadQueue = modelLoadQueue.then(() => loadModelLayer(url)).catch(() => {});
  }

  // ---------------------------------------------------------------- pointer --
  function classifyTapByName(hits) {
    if (!hits || hits.length === 0) return null;
    const matchers = [
      { part: "head", re: /head|hair|face|头/i },
      { part: "leg", re: /leg|foot|feet|shoe|腿|脚/i },
      { part: "arm", re: /arm|hand|手/i }
    ];
    for (const matcher of matchers) {
      if (hits.some((name) => matcher.re.test(name))) return matcher.part;
    }
    return "body";
  }

  function classifyTapByPosition(localX, localY, bounds, tap) {
    if (!(bounds.width > 0 && bounds.height > 0)) return null;
    const nx = (localX - bounds.x) / bounds.width;
    const ny = (localY - bounds.y) / bounds.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
    if (ny < tap.headMaxNy && nx >= tap.headMinNx && nx <= tap.headMaxNx) return "head";
    if (ny > tap.legMinNy && nx >= tap.bodyMinNx && nx <= tap.bodyMaxNx) return "leg";
    if (ny >= tap.armMinNy && ny <= tap.legMinNy) {
      if (nx >= tap.armLeftMinNx && nx < tap.bodyMinNx) return "arm";
      if (nx > tap.bodyMaxNx && nx <= tap.armRightMaxNx) return "arm";
    }
    if (ny >= tap.headMaxNy && ny <= tap.legMinNy && nx >= tap.bodyMinNx && nx <= tap.bodyMaxNx) {
      return "body";
    }
    return null;
  }

  function classifyTap(hits, localX, localY, bounds, tap) {
    const named = classifyTapByName(hits);
    if (named === "head" || named === "leg" || named === "arm") return named;
    if (bounds) {
      const spatial = classifyTapByPosition(localX, localY, bounds, tap);
      if (spatial !== null) return spatial;
    }
    return named;
  }

  function handleTap(event) {
    if (!model) return;
    const now = Date.now();
    if (now - lastTapAt < TAP_DEBOUNCE_MS) return;
    lastTapAt = now;
    try {
      const rect = canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      const hits = model.hitTest(localX, localY) || [];
      let bounds = null;
      try {
        const box = model.getBounds && model.getBounds();
        if (box && box.width > 0 && box.height > 0) {
          bounds = { x: box.x, y: box.y, width: box.width, height: box.height };
        }
      } catch (error) {
        /* no bounds: hit areas only */
      }
      const part = classifyTap(hits, localX, localY, bounds, spatialTap);
      if (!part) return;
      const poolKey = "tap" + part.charAt(0).toUpperCase() + part.slice(1);
      const line = pickLine(activeCopy[poolKey], lastTapLine[poolKey]);
      if (line !== undefined) {
        lastTapLine[poolKey] = line;
        showBubble(line);
      }
      interactionGen += 1;
      void startMotionWithPriority(motionNamesFor(part), MotionPriority.FORCE, {
        suppressFocus: true,
        isInteraction: true
      });
    } catch (error) {
      /* ignore a failed hit test */
    }
  }

  function bindPointer(element) {
    element.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      down = { x: event.clientX, y: event.clientY, screenX: event.screenX, screenY: event.screenY };
      dragging = false;
      try {
        element.setPointerCapture(event.pointerId);
      } catch (error) {
        /* capture is best effort */
      }
    });

    element.addEventListener("pointermove", (event) => {
      if (!down) return;
      const dx = event.clientX - down.x;
      const dy = event.clientY - down.y;
      if (!dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        dragging = true;
        element.classList.add("dragging");
        bubbleEl.style.opacity = "0";
        bridge.dragStart(down.screenX, down.screenY);
      }
      if (dragging) bridge.dragMove(event.screenX, event.screenY);
    });

    const finish = (event) => {
      if (!down) return;
      const wasDragging = dragging;
      down = null;
      dragging = false;
      element.classList.remove("dragging");
      if (wasDragging) {
        bridge.dragEnd();
        if (stagedState) showStageText();
      } else {
        handleTap(event);
      }
    };
    element.addEventListener("pointerup", finish);
    element.addEventListener("pointercancel", () => {
      down = null;
      dragging = false;
      element.classList.remove("dragging");
    });

    // Double click opens the client window, single click keeps petting: the tap
    // interaction is the plugin's whole point, so it cannot be the thing that
    // gets taken away. Nobody can see this gesture, so the shell documents it
    // (README) and the tray menu keeps a plain "打开" for discovery.
    element.addEventListener("dblclick", () => {
      if (typeof bridge.openClient === "function") bridge.openClient();
    });
  }

  // ------------------------------------------------------------------ boot --
  function effectiveMaxFps() {
    return maxFps === 0 ? UNLIMITED_FPS_CEILING : maxFps;
  }

  function normalizeMaxFps(raw) {
    return raw === 60 || raw === 30 || raw === 0 ? raw : DEFAULT_MAX_FPS;
  }

  function applyTicker() {
    if (!app) return;
    try {
      app.ticker.maxFPS = effectiveMaxFps();
      if (enabled) app.ticker.start();
      else app.ticker.stop();
    } catch (error) {
      /* older ticker */
    }
  }

  function applyConfig(next) {
    const config = next.config || {};
    if (typeof config.maxFps === "number") {
      maxFps = normalizeMaxFps(config.maxFps);
      applyTicker();
    }
    const nextEnabled = config.enabled !== false;
    if (nextEnabled !== enabled) {
      enabled = nextEnabled;
      bubbleEl.style.opacity = enabled ? bubbleEl.style.opacity : "0";
      applyTicker();
      bridge.setEnabled(enabled);
    }
    if (config.spatialTap) spatialTap = Object.assign({}, DEFAULT_SPATIAL_TAP, config.spatialTap);
    motionMap = Object.assign({}, DEFAULT_MOTION_MAP, config.motionMap || {});
    if (typeof config.size === "number" && config.size > 0) scheduleSize(config.size);
    const nextUrl = config.modelUrl || null;
    if (nextUrl !== currentModelUrl) {
      currentModelUrl = nextUrl;
      queueModelLoad(nextUrl);
    }
  }

  function applyState(next) {
    if (!next || !next.config) return;
    view = next;

    const personaId = next.config.persona || DEFAULT_PERSONA_ID;
    const personasJson = JSON.stringify(next.customPersonas || []);
    if (personaId !== activePersonaId || personasJson !== lastPersonasJson) {
      activePersonaId = personaId;
      lastPersonasJson = personasJson;
      activeCopy = resolvePersonaCopy(personaId, next.customPersonas);
      if (stagedState && !dragging) showStageText();
    }

    applyConfig(next);

    const state = next.state || "idle";
    if (state !== lastState) {
      lastState = state;
      if (STAGED_DELAYS[state]) {
        enterStaged(state);
      } else {
        clearStages();
        const key = TRANSIENT_COPY_KEYS[state];
        const line = key ? pickLine(activeCopy[key]) : undefined;
        if (line !== undefined) showBubble(line);
      }
      playState(state);
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const element = document.createElement("script");
      element.src = src;
      element.onload = () => resolve();
      element.onerror = () => reject(new Error("script load failed: " + src));
      document.head.appendChild(element);
    });
  }

  /** One snapshot attempt; `null` means the pet routes are not answering. */
  async function fetchState() {
    try {
      const response = await fetch("/api/state");
      if (!response.ok) return null;
      const state = await response.json();
      return state && state.config ? state : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Wait for the plugin to answer, then keep watching for it.
   *
   * `dsh-live2d-pets` is what serves these routes, so a failure means the plugin
   * is missing rather than that something is broken here — and the overlay has a
   * placeholder paw for a missing model, which would otherwise sit on the user's
   * desktop forever. Instead the pet stays invisible until a snapshot arrives,
   * which also makes "install the plugin while the client is running" work: the
   * SSE reconnects, its `open` event triggers another snapshot, and the pet
   * appears without a restart.
   */
  async function refreshState(attempts, delayMs) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const state = await fetchState();
      if (state) {
        pluginReachable = true;
        return state;
      }
      if (attempt < attempts - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      }
    }
    return null;
  }

  function subscribe() {
    try {
      const source = new EventSource("/api/events");
      source.onopen = () => {
        // The stream only opens while the plugin's route exists.
        if (!pluginReachable) void refreshState(2, 400).then((state) => state && applyState(state));
      };
      source.onmessage = (event) => {
        debug.sseMessages += 1;
        pluginReachable = true;
        try {
          applyState(JSON.parse(event.data));
        } catch (error) {
          /* ignore a malformed frame */
        }
      };
      source.onerror = () => {
        debug.sseErrors += 1;
        /* EventSource reconnects on its own; the server resends a snapshot */
      };
    } catch (error) {
      debug.lastError = "sse subscribe failed: " + String(error);
    }
  }

  async function boot() {
    const initial = await refreshState(3, 500);

    if (initial) {
      pos.size = initial.config.size || pos.size;
      maxFps = normalizeMaxFps(initial.config.maxFps);
      enabled = initial.config.enabled !== false;
    } else {
      // No plugin, no pet: hide rather than park a placeholder on the desktop.
      enabled = false;
      debug.lastError = "pet plugin unreachable";
    }
    bridge.setEnabled(enabled);

    newCanvas();
    layout();

    // Attach the geometry reporting before anything slow: loading the vendor
    // scripts takes seconds, and the window resize that `layout` just asked for
    // lands somewhere inside that window. A canvas rectangle nobody refreshes
    // is a pet whose clicks fall through to the DSH window behind it.
    window.addEventListener("resize", reportCanvasRect);
    if (typeof bridge.onMeasure === "function") bridge.onMeasure(reportCanvasRect);
    // The very first request is sent while the window still has its previous
    // size, so measure once more after this frame has been laid out.
    window.requestAnimationFrame(reportCanvasRect);

    try {
      for (const src of VENDOR_SCRIPTS) await loadScript(src);
    } catch (error) {
      showFallback();
    }

    if (initial) applyState(initial);
    subscribe();

    bridge.onCursor((point) => {
      lastCursor = point;
      if (!enabled || dragging || focusSuppressed) return;
      applyFocus(point.x, point.y);
    });

    bridge.ready();
    debug.booted = true;
  }

  void boot();
})();
