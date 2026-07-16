/**
 * Multimodal order parse on Supabase Edge:
 * voice text + product-label images + PDF/DOCX + link
 * → structured fields via NVIDIA NIM (vision + LLM).
 *
 * Secret: NVIDIA_API_KEY
 * Frontend: POST multipart (voice_text, link, files) to
 *   /functions/v1/parse-order
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1/chat/completions";
const VISION_MODEL = "nvidia/llama-3.1-nemotron-nano-vl-8b-v1";
// nemotron-nano currently hangs on NIM; use a responsive instruct model
const LLM_MODEL = "meta/llama-3.1-8b-instruct";

const MAX_FILES = 5;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const FIELD_KEYS = [
  "Product Name",
  "Program",
  "Country of Origin",
  "Countries/Regions of Distribution",
  "Item#/model#",
  "Manufacturer",
  "Manufacturer Address",
  "Sample Collection Method",
  "Electric Product",
  "Product Description",
  "Carrier",
  "Tracking Number",
  "Shipping Remark",
] as const;

const MARK_TO_REGIONS: Record<string, string[]> = {
  CE: ["欧盟"],
  UKCA: ["英国"],
  UKNI: ["英国"],
  FCC: ["美国"],
  FC: ["美国"],
  FDA: ["美国"],
  CCC: ["中国"],
  PSE: ["日本"],
  KC: ["韩国"],
  RCM: ["澳大利亚"],
  EAC: ["俄罗斯"],
};

/** Canonical Program options (AIMS display strings). Skip "… - Copy". */
const PROGRAM_CATALOG = [
  "TEMU Toys - TEMU Pay（TEMU 付款-玩具产品）",
  "TEMU Textile (Sleepwear) - TEMU Pay（TEMU 付款，睡衣产品）",
  "TEMU Hardware- Seller Pay（商家付款，杂货产品）",
  "DEFAULT",
  "TEMU Textile (Non-Sleepwear) - Seller Pay（商家付款，非睡衣类纺织品产品）",
  "TEMU FCM-Seller Pay（商家付款，食品接触产品）",
  "TEMU FCM-TEMU Pay（Temu 付款，食品接触产品）",
  "TEMU Textile (Non-Sleepwear) - TEMU Pay（TEMU 付款，非睡衣类纺织品产品）",
  "TEMU Toys - Seller Pay（商家付款，玩具产品）",
  "TEMU Textile (Sleepwear) - Seller Pay（商家付款，睡衣产品）",
  "TEMU Eyewear(PPE)-Seller Pay（商家付款,PPE 眼镜产品）",
  "TEMU Electric product -Seller Pay（商家付款，电子产品）",
  "SH-Self",
  "TEMU MSDS-Seller Pay（商家付款，只做MSDS专用program）",
] as const;

const PROGRAM_BY_KEY: Record<string, string> = {
  toys_temu: "TEMU Toys - TEMU Pay（TEMU 付款-玩具产品）",
  toys_seller: "TEMU Toys - Seller Pay（商家付款，玩具产品）",
  sleepwear_temu: "TEMU Textile (Sleepwear) - TEMU Pay（TEMU 付款，睡衣产品）",
  sleepwear_seller: "TEMU Textile (Sleepwear) - Seller Pay（商家付款，睡衣产品）",
  non_sleepwear_temu:
    "TEMU Textile (Non-Sleepwear) - TEMU Pay（TEMU 付款，非睡衣类纺织品产品）",
  non_sleepwear_seller:
    "TEMU Textile (Non-Sleepwear) - Seller Pay（商家付款，非睡衣类纺织品产品）",
  hardware_seller: "TEMU Hardware- Seller Pay（商家付款，杂货产品）",
  fcm_seller: "TEMU FCM-Seller Pay（商家付款，食品接触产品）",
  fcm_temu: "TEMU FCM-TEMU Pay（Temu 付款，食品接触产品）",
  eyewear_seller: "TEMU Eyewear(PPE)-Seller Pay（商家付款,PPE 眼镜产品）",
  electric_seller: "TEMU Electric product -Seller Pay（商家付款，电子产品）",
  msds_seller: "TEMU MSDS-Seller Pay（商家付款，只做MSDS专用program）",
  sh_self: "SH-Self",
  default: "DEFAULT",
};

type FieldMap = Record<string, string>;

function compactProgramKey(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s\-–—_/()（）,，.·]+/g, "")
    .replace(/selly/g, "seller");
}

function resolveProgramLabel(value: string): string {
  const v = String(value ?? "").trim();
  if (!v) return "";
  if (/^__PROGRAM_TEMU_TOY__$/.test(v)) return PROGRAM_BY_KEY.toys_seller;
  if (/^__PROGRAM_TEMU_HW__$/.test(v)) return PROGRAM_BY_KEY.hardware_seller;
  if (/^__PROGRAM_AMAZON__$/.test(v)) return "";
  for (const label of PROGRAM_CATALOG) {
    if (label === v) return label;
  }
  const compact = compactProgramKey(v);
  if (compact.length >= 6) {
    for (const label of PROGRAM_CATALOG) {
      if (compactProgramKey(label) === compact) return label;
    }
  }
  if (compact.length >= 14) {
    for (const label of PROGRAM_CATALOG) {
      const cLabel = compactProgramKey(label);
      if (cLabel.includes(compact) || compact.includes(cLabel)) {
        return label;
      }
    }
  }
  if (
    /temu.*hardware|hardware.*seller|硬件|杂货/i.test(v) &&
    /seller|商家|退款|refund/i.test(v)
  ) {
    return PROGRAM_BY_KEY.hardware_seller;
  }
  if (
    /temu.*toys?|toys?.*seller|玩具/i.test(v) &&
    /seller|商家/i.test(v) &&
    !/temu\s*pay|temu付款|付款/i.test(v)
  ) {
    return PROGRAM_BY_KEY.toys_seller;
  }
  if (/temu.*toys?|玩具/i.test(v) && /temu\s*pay|temu付款|付款/i.test(v)) {
    return PROGRAM_BY_KEY.toys_temu;
  }
  if (/msds/i.test(v)) return PROGRAM_BY_KEY.msds_seller;
  if (/^sh[-\s]?self$/i.test(v) || /自助\s*program|self\s*program/i.test(v)) {
    return PROGRAM_BY_KEY.sh_self;
  }
  if (/^default$/i.test(v)) return PROGRAM_BY_KEY.default;
  return "";
}

function detectProgramPayer(text: string): "" | "temu" | "seller" {
  const t = String(text || "");
  const temuPay = /TEMU\s*Pay|TEMU\s*付款|Temu\s*付款|平台付款|TEMU付款/i.test(t);
  const sellerPay =
    /Seller\s*Pay|Selly\s*Pay|商家付款|卖家付款|seller\s*paid/i.test(t);
  if (temuPay && !sellerPay) return "temu";
  if (sellerPay && !temuPay) return "seller";
  if (temuPay && sellerPay) {
    if (
      /Program.{0,40}(?:TEMU\s*Pay|TEMU\s*付款)|(?:TEMU\s*Pay|TEMU\s*付款).{0,40}Program/i
        .test(t)
    ) {
      return "temu";
    }
    if (
      /Program.{0,40}(?:Seller\s*Pay|商家付款)|(?:Seller\s*Pay|商家付款).{0,40}Program/i
        .test(t)
    ) {
      return "seller";
    }
  }
  return "";
}

function detectProgramCategory(
  text: string,
  hints: { productName?: string; electricYes?: boolean } = {},
): string {
  const t = String(text || "");
  const name = String(hints.productName || "").trim();
  const blob = (name + "\n" + t).toLowerCase();
  const electricHint = !!hints.electricYes;

  // 1) Explicit MSDS-only program
  if (
    /\b(?:msds\s*only|only\s*msds|msds\s*program)\b/i.test(blob) ||
    (/msds/i.test(blob) && /只做|专用|only/i.test(blob))
  ) {
    return "msds";
  }
  // 2) Chemical / cosmetic / coating — products that need an SDS/MSDS
  //    (nail polish, perfume, paint, adhesive, detergent, solvent, ink, aerosol…)
  if (
    /\b(?:nail\s*polish|polish|cosmetic|cosmetics|makeup|perfume|fragrance|eau\s*de|paint|coating|varnish|lacquer|adhesive|glue|resin|detergent|cleaner|solvent|ink|aerosol|chemicals?|hazardous)\b/i
      .test(blob) ||
    /指甲油|化妆品|香水|卸妆|染发剂|漂发剂|洗甲水|油漆|涂料|涂层|胶水|粘合剂|树脂|清洁剂|洗涤剂|溶剂|油墨|气雾剂|化学品|危险品|脱漆/.test(
      blob,
    )
  ) {
    return "msds";
  }
  // 3) SH-Self
  if (/\bsh[-\s]?self\b|\bself\s*program\b/i.test(blob) || /自助\s*program/.test(blob)) {
    return "sh_self";
  }
  // 4) Eyewear / PPE
  if (
    /\b(?:eyewear|sunglasses|glasses|goggles|spectacles|ppe\b|safety\s*glasses|reading\s*glasses)\b/i
      .test(blob) ||
    /护目镜|太阳镜|眼镜|镜架|镜片/.test(blob)
  ) {
    return "eyewear";
  }
  // 5) Electric — only with concrete powered evidence (never from category guess alone)
  if (
    electricHint ||
    /__ELECTRIC_YES__/i.test(t) ||
    /\b(?:electric\s+fan|electric\s+product|electronics?|voltage|charger|motor|adapter)\b/i
      .test(blob) ||
    /电源|电机|充电|电池|电压|功率|电子产品|电风扇|带电/.test(blob) ||
    /\d+\s*V(?:olt)?|\d+\s*W(?:att)?|\d+\s*Hz/i.test(blob)
  ) {
    const toyCue =
      /\b(?:toy|toys|en\s*71|cpsia)\b/i.test(blob) ||
      /玩具|机器人玩具|积木|毛绒/.test(blob);
    const electricName =
      /\b(?:fan|lamp|light|heater|blender|mixer|vacuum|speaker|headphones?|earphones?|shaver|straightener|hair\s*dryer)\b/i
        .test(blob) ||
      /耳机|风扇|台灯|吹风机|充电器|剃须刀|直发器|带电产品|电子产品/.test(blob) ||
      /electric\s+product/i.test(blob);
    if (electricName || (electricHint && !toyCue)) return "electric";
    if (!toyCue) return "electric";
  }
  // 6) Food contact materials (tableware / drinkware / cookware that touches food)
  if (
    /\b(?:food\s*contact|fcm\b|lfgb|tableware|cutlery|flatware|chopsticks|mug|cup|glass(?:es)?|bottle|tumbler|plate|bowl|dish|cookware|pan\b|pot\b|wok|tray|food\s*container|lunchbox|cutting\s*board|chopping\s*board|wine\s*glass)\b/i
      .test(blob) ||
    /食品接触|餐具|水杯|杯子|餐盒|餐盘|碗|碟|锅|壶|砧板|菜板|筷子|刀叉|餐刀/.test(blob)
  ) {
    return "fcm";
  }
  // 7) non-sleepwear before sleepwear (hyphenated "non-sleepwear" contains "sleepwear")
  if (/\bnon[-\s]?sleepwear\b/i.test(blob) || /非睡衣/.test(blob)) {
    return "non_sleepwear";
  }
  if (
    /\b(?:sleepwear|pajamas?|pyjamas?|nightgown|nightwear|onesie|sleep\s*sack)\b/i
      .test(blob) ||
    /睡衣|睡袍|家居服|睡袋/.test(blob)
  ) {
    return "sleepwear";
  }
  if (
    /\b(?:textile|fabric|apparel|garment|clothing|shirt|t[-\s]?shirt|dress|blouse|pants?|trousers|jeans|underwear|socks?|towel|bedding|linen|hat|scarf|glove|gloves)\b/i
      .test(blob) ||
    /面料|纺织|衣服|服装|布料|衬衫|t恤|裙子|裤|内衣|袜子|毛巾|床品|帽子|围巾|手套/.test(blob)
  ) {
    return "non_sleepwear";
  }
  // 8) Toys
  if (
    /\b(?:toy|toys|en\s*71|cpsia|plush|doll|figurine|puzzle|spinner|rc\b|remote\s*control|water\s*gun|building\s*block|toy\s*car)\b/i
      .test(blob) ||
    /玩具|积木|公仔|毛绒|娃娃|手办|拼图|陀螺|遥控|水枪|玩具车/.test(blob)
  ) {
    return "toys";
  }
  // 9) Hardware / grocery (non-food tools, fasteners, gadgets)
  if (
    /\b(?:hardware|grocery|kitchen\s*gadget|screwdriver|wrench|pliers|hammer|saw|drill|fastener|screw|bolt|nut|washer|scissors|tape\s*measure|utility\s*knife|tools?)\b/i
      .test(blob) ||
    /杂货|五金|厨具|日用|螺丝|螺钉|螺栓|螺母|垫片|紧固件|工具|扳手|钳|锤|锯|剪刀|卷尺/.test(
      blob,
    ) ||
    (/temu/i.test(blob) && /硬件|杂货/.test(t))
  ) {
    return "hardware";
  }
  if (/\bdefault\b/i.test(blob) && /program|关联项目|项目/i.test(blob)) {
    return "default";
  }
  // 10) Nothing recognizable → DEFAULT (never leave Program empty on auto-fill)
  return "default";
}

function matchProgramFromText(
  text: string,
  hints: { productName?: string; electricYes?: boolean } = {},
): string {
  const raw = String(text || "");
  if (!raw && !hints.productName) return "";

  const programMention = raw.match(
    /(?:关联)?(?:项目|Program)\s*[是为：:=]\s*([^\n，。;；]{2,80})/i,
  );
  const direct = resolveProgramLabel(programMention?.[1]?.trim() || "");
  if (direct) return direct;

  for (const label of PROGRAM_CATALOG) {
    if (label.length >= 4 && raw.includes(label)) return label;
    const compactLabel = compactProgramKey(label);
    if (
      compactLabel.length >= 8 &&
      compactProgramKey(raw).includes(compactLabel)
    ) {
      return label;
    }
  }

  const category = detectProgramCategory(raw, hints);
  if (!category) return "";
  if (category === "default") return PROGRAM_BY_KEY.default;
  if (category === "sh_self") return PROGRAM_BY_KEY.sh_self;
  if (category === "electric") return PROGRAM_BY_KEY.electric_seller;
  if (category === "hardware") return PROGRAM_BY_KEY.hardware_seller;
  if (category === "eyewear") return PROGRAM_BY_KEY.eyewear_seller;
  if (category === "msds") return PROGRAM_BY_KEY.msds_seller;

  let payer = detectProgramPayer(raw) || "seller";
  const key = `${category}_${payer}`;
  if (PROGRAM_BY_KEY[key]) return PROGRAM_BY_KEY[key];
  return PROGRAM_BY_KEY[`${category}_seller`] || "";
}

function programLabelCategory(label: string): string {
  const resolved = resolveProgramLabel(label);
  if (!resolved) return "";
  for (const k in PROGRAM_BY_KEY) {
    if (PROGRAM_BY_KEY[k] === resolved) {
      if (k === "default") return "default";
      if (k === "sh_self") return "sh_self";
      return k.replace(/_(temu|seller)$/, "");
    }
  }
  return "";
}

function ensureProgramMatched(
  fields: FieldMap,
  opts: { rawExcerpt?: string } = {},
): FieldMap {
  const existing = resolveProgramLabel(fields.Program || "");
  const hintText = [
    opts.rawExcerpt || "",
    fields["Product Name"] || "",
    fields["Product Description"] || "",
    fields["Electric Product"] || "",
    fields["Shipping Remark"] || "",
  ].join("\n");
  const matched = matchProgramFromText(hintText, {
    productName: fields["Product Name"] || "",
    electricYes:
      /带电|electric\s*yes|^electric$/i.test(
        String(fields["Electric Product"] || ""),
      ),
  });
  if (existing) {
    // Reconcile: only override with HIGH-CONFIDENCE detector categories
    // (chemical->MSDS, electric, eyewear, sh_self) where keyword evidence is
    // reliable. Avoids false-positive overrides on overlapping buckets
    // (e.g. "bottle opener" -> FCM vs Hardware). Payer from LLM is preserved.
    const STRONG: Record<string, 1> = { msds: 1, electric: 1, eyewear: 1, sh_self: 1 };
    const existingCat = programLabelCategory(existing);
    const detectedCat = programLabelCategory(matched);
    if (detectedCat && STRONG[detectedCat] && detectedCat !== existingCat) {
      const payer = /temu\s*pay|temu付款/i.test(existing) ? "temu" : "seller";
      let key = detectedCat === "non_sleepwear"
        ? `non_sleepwear_${payer}`
        : `${detectedCat}_${payer}`;
      if (!PROGRAM_BY_KEY[key]) {
        key = detectedCat === "non_sleepwear"
          ? "non_sleepwear_seller"
          : `${detectedCat}_seller`;
      }
      fields.Program = PROGRAM_BY_KEY[key] || matched || existing;
    } else {
      fields.Program = existing;
    }
    return fields;
  }
  fields.Program = matched || PROGRAM_BY_KEY.default;
  return fields;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allow =
    origin &&
      (origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1") ||
        origin.includes("vercel.app") ||
        origin.includes("github.io"))
      ? origin
      : "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  origin: string | null,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function nvidiaChat(payload: Record<string, unknown>): Promise<string> {
  const apiKey = Deno.env.get("NVIDIA_API_KEY") || "";
  if (!apiKey) throw new Error("missing_nvidia_key");
  const res = await fetch(NVIDIA_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 500);
    throw new Error(`upstream_http_${res.status}:${errBody}`);
  }
  const body = await res.json();
  const choices = body?.choices || [];
  if (!choices.length) return "";
  return String(choices[0]?.message?.content || "").trim();
}

function isImage(filename: string, mime: string): boolean {
  if (mime.startsWith("image/")) return true;
  return /\.(jpe?g|png|gif|webp|bmp|heic)$/i.test(filename);
}

function parseJsonFromLlm(text: string): Record<string, unknown> {
  let t = (text || "").trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("invalid_llm_json");
  }
}

/** Keep product_name concise — strip service wrappers and trailing clauses. */
function cleanProductName(raw: string): string {
  let name = String(raw || "").replace(/\s+/g, " ").trim();
  if (!name) return "";

  name = name.replace(
    /^(?:实验室(?:检测|测试)|检测服务|验货服务|装运前(?:检测|检验)|质检|Lab(?:oratory)?\s*(?:testing|test|inspection)|Pre[-\s]?Shipment\s*Inspection|PSI|Inspection|Testing)\s*[·•\-–—|:\/]+\s*/i,
    "",
  );
  name = name.replace(/^[·•]\s*/, "");
  name = name.replace(
    /^(?:我需要|我想要|我想|请帮我|帮我|需要)?(?:给|为|对)?(?:一款|一个|一台|一件)?(?:做|进行|申请|下单|测试|检测|测)?(?:一下)?(?:实验室)?(?:检测|测试|验货|服务)?(?:订单)?[：:\s]*/i,
    "",
  );
  name = name.replace(
    /^(?:(?:I|we)\s+(?:need|want|would\s+like)|please)\s+/i,
    "",
  );
  name = name.replace(
    /^(?:(?:to\s+)?(?:order|book|do|get|request)\s+)?(?:lab(?:oratory)?\s+)?(?:testing|test|inspection)\s+(?:for|of|on)\s+/i,
    "",
  );
  name = name.replace(/^product\s*name\s*[:：=]\s*/i, "");
  name = name.replace(/^品名\s*[:：=]\s*/, "");
  name = name.replace(/^产品名称\s*[:：=]\s*/, "");
  name = name.replace(/^名称\s*[:：=]\s*/, "");
  name = name.split(
    /\s+(?:sold\s+(?:in|to|for)|manufactured\s+by|made\s+(?:by|in)|produced\s+by|exported\s+to|shipped\s+to|distribut(?:ed|ion)\s+(?:in|to|for)|intended\s+for|for\s+(?:the\s+)?(?:US|U\.S\.|USA|UK|EU|European|American|Chinese|market)|from\s+(?:the\s+)?(?:factory|manufacturer|supplier)|that\s+(?:is|are|was|were|has|have)|which\s+(?:is|are|was|were)|and\s+(?:I|we|the|it)|(?:I|we)\s+(?:need|want|will)|with\s+(?:batter|power)|Model\b|型号|item\s*(?:no\.?|number|#)|SKU|P\s*\/?\s*N)\b/i,
  )[0];
  name = name.split(
    /(?:[，,。；;]\s*)?(?:销往|销售(?:国家|地区|市场)?|出口到?|运往|发往|制造商(?:名称|全称)?|厂家|工厂|生产商|厂商|原产(?:国家或地区|国|地)|产自|产地|型号|货号|规格|标准|SKU|需要(?:做)?(?:检测|测试)|做(?:实验室)?检测|检测服务|带电|非电|样本|送样|寄送)/,
  )[0];
  name = name.replace(/^(?:一款|一个|一台|一件|这种|这个|那个|该|a|an|the|my|our|this|that)\s+/i, "").trim();
  name = name.replace(/(?:做(?:实验室)?(?:检测|测试)|的检测|的测试|for\s+(?:lab\s+)?(?:testing|test|inspection))$/i, "").trim();
  name = name.replace(/[,，。.;；:：!！?？\-_~–—|/\\·•]+$/g, "").trim();
  name = name.replace(/^[,，。.;；:：\-_~–—|/\\·•]+/, "").trim();
  name = name.replace(/_{2,}/g, " ").replace(/\s+/g, " ").trim();

  // Strip document metadata glued by OCR onto the product name
  // e.g. "NAIL POLISH M SDS Number (version number)" -> "NAIL POLISH"
  name = name.replace(/\s*\(?\s*version\s+(?:no\.?|number|#)\s*\)?\s*$/i, "");
  name = name.replace(/\s+(?:M\s+)?M?\s*S\s*D\s*S\b.*$/i, "");
  name = name.replace(/\s+(?:Material\s+)?Safety\s+Data\s+Sheet\b.*$/i, "");
  name = name.replace(/\s+M\s*S\s*D\s*S\b.*$/i, "");
  name = name.replace(/\s+Version\s*(?:No\.?|Number|#)\b.*$/i, "");
  name = name.replace(
    /\s+(?:Report|Certificate|Cert\.?|Lot|Batch|Item|Doc\.?|Document)\s*(?:No\.?|Number|#)\b.*$/i,
    "",
  );
  name = name.replace(/\s+\(?\s*version\s+number\s*\)?\s*$/i, "");
  name = name.replace(/\s+/g, " ").trim();

  const hasCjk = /[\u4e00-\u9fff]/.test(name);
  const maxLen = hasCjk ? 24 : 48;
  if (name.length > maxLen) {
    if (hasCjk) {
      name = name.slice(0, maxLen).replace(/[的地得了着过与和及]$/, "");
    } else {
      const cut = name.slice(0, maxLen);
      const sp = cut.lastIndexOf(" ");
      name = (sp > 12 ? cut.slice(0, sp) : cut).trim();
    }
  }
  if (looksLikeNonProductName(name)) return "";
  if (
    /^(?:实验室(?:检测|测试)?|检测服务|验货|装运前(?:检测|检验)|Lab(?:oratory)?\s*(?:testing|test|inspection)?|Pre[-\s]?Shipment\s*Inspection|PSI|Inspection|Testing)$/i
      .test(name)
  ) {
    return "";
  }
  if (
    /^(?:实验室|检测|测试|lab|testing|inspection)\b/i.test(name) &&
    !/(?:玩具|机器人|风扇|鼠标|直发|电吹|Fan|Toy|Mouse|Robot|Straightener|Hair)/i
      .test(name)
  ) {
    if (name.length > 12) return "";
  }
  const commaCount = (name.match(/[,，;；]/g) || []).length;
  if (commaCount >= 2) return "";
  if (
    /\b(?:sold\s+in|manufactured\s+by|I\s+need|lab\s+testing\s+for|销往|制造商)\b/i
      .test(name)
  ) {
    return "";
  }
  const wordCount = name.split(/\s+/).filter(Boolean).length;
  if (!hasCjk && wordCount > 8) return "";
  return name.length >= 2 ? name : "";
}

/** Model codes / ratings / standards / watermarks — never product names. */
function looksLikeNonProductName(s: string): boolean {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (
    /^(?:型号|名称|品名|规格|标准|Manufacturer|Model|Rating|Address|Product)$/i
      .test(t)
  ) {
    return true;
  }
  if (/(?:wenku\.baidu|baidu\.com|docin\.com|http)/i.test(t)) return true;
  if (/^(?:EN|IEC|ISO|UL|ASTM|GB\/?T?)\s*[-.]?\d/i.test(t)) return true;
  if (
    /\bEN\s*60335|\bIEC\s*\d|GB\/T?\s*\d/i.test(t) &&
    !/[\u4e00-\u9fff]/.test(t)
  ) {
    return true;
  }
  if (
    /(?:\d+\s*(?:Vac?|V(?:ac)?|Hz|k?W|mA|A)\b).{0,20}(?:\d+\s*(?:Vac?|V|Hz|W))/i
      .test(t)
  ) {
    return true;
  }
  if (/^\d+\s*(?:Vac?|V|Hz|W|mA)\b/i.test(t)) return true;
  const compact = t.replace(/\s+/g, "");
  if (!/[\u4e00-\u9fff]/.test(compact)) {
    if (
      /^[A-Za-z]{1,5}\d{2,8}[A-Za-z0-9\-_./#]*$/i.test(compact) ||
      /^\d{2,6}[A-Za-z]{1,4}\d{0,4}$/i.test(compact)
    ) {
      return true;
    }
  }
  return false;
}

function countWords(s: string): number {
  return String(s || "").trim().split(/\s+/).filter(Boolean).length;
}

function looksLikeSentence(s: string): boolean {
  const t = String(s || "").trim();
  if (!t) return false;
  if (t.length > 120) return true;
  if (
    /\b(?:I\s+need|we\s+need|please|sold\s+in|manufactured\s+by|lab\s+testing\s+for|我想|我需要|帮我|销往|制造商是)\b/i
      .test(t)
  ) {
    return true;
  }
  if (/[。.！？!?]/.test(t) && t.length > 40) return true;
  const commas = (t.match(/[,，;；]/g) || []).length;
  if (commas >= 2 && t.length > 50) return true;
  if (commas >= 3) return true;
  return false;
}

function looksLikeAddress(s: string): boolean {
  return /(?:路|街|号|区|市|省|镇|村|大道|Building|Bldg|Floor|Fl\.|Road|Rd\.|Street|St\.|Ave|Avenue|District|City|Province|Zip|邮编|P\.?O\.?\s*Box|\d{1,5}\s+[A-Za-z])/i
    .test(s);
}

function looksLikeTracking(s: string): boolean {
  const t = String(s || "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9\-]{8,32}$/.test(t)) return false;
  if (/[A-Za-z]/.test(t) && /\d/.test(t)) return true;
  if (/^\d{10,22}$/.test(t)) return true;
  return false;
}

function looksLikeCompanyName(s: string): boolean {
  const t = String(s || "").trim();
  if (!t || t.length < 2 || t.length > 80) return false;
  if (looksLikeAddress(t) && t.length > 40) return false;
  if (looksLikeTracking(t)) return false;
  if (/^(?:MADE\s+IN|Rating|Model|Address|Contact)\b/i.test(t)) return false;
  if (/\d+\s*V|\d+\s*W|\d+\s*Hz|Rated|Rating/i.test(t) && t.length < 40) {
    return false;
  }
  return /[\u4e00-\u9fffA-Za-z]/.test(t) && !looksLikeSentence(t);
}

/** Concrete electrical evidence actually visible in the source text. */
function hasElectricEvidence(text: string): boolean {
  const t = String(text || "");
  if (!t) return false;
  return /(?:\b\d+(?:\.\d+)?\s*(?:V(?:olt)?|W(?:att)?|Hz|mA|A)\b)|battery|batteries|rechargeable|锂电池|干电池|纽扣电池|蓄电池|充电电池|电池|charger|充电|adapter|适配器|电源|电机|马达|电动|Rated|Rating|Input|Output|Power\s*supply|USB|Type-?C|DC\s*in|AC\s*adapter|电压|功率|电流|带电|electric\s+product|带电产品/i
    .test(t);
}

const KNOWN_ORIGIN_RE =
  /^(?:中国|China|CN|PRC|越南|Vietnam|VN|印度|India|IN|美国|USA?|United\s+States|英国|UK|United\s+Kingdom|欧盟|EU|European\s+Union|德国|Germany|DE|法国|France|FR|意大利|Italy|IT|日本|Japan|JP|韩国|Korea|KR|加拿大|Canada|CA|澳大利亚|Australia|AU|墨西哥|Mexico|MX|泰国|Thailand|TH|马来西亚|Malaysia|MY|印尼|Indonesia|ID|台湾|Taiwan|TW|香港|Hong\s+Kong|HK)$/i;

const KNOWN_REGION_TOKEN_RE =
  /^(?:中国|欧盟|英国|美国|日本|韩国|澳大利亚|加拿大|德国|法国|意大利|越南|印度|墨西哥|泰国|马来西亚|印尼|台湾|香港|Russia|俄罗斯|南美|中东|全球|Worldwide|Global|EU|UK|USA?|China|Japan|Korea|Australia|Canada)$/i;

const KNOWN_CARRIER_RE =
  /^(?:顺丰(?:速运|快递)?|SF\s*Express|中通(?:快递)?|圆通(?:速递)?|韵达(?:快递)?|京东(?:物流|快递)?|极兔(?:速递)?|申通(?:快递)?|德邦|邮政(?:EMS)?|EMS|DHL|UPS|FedEx|TNT|Aramex|YTO|ZTO|STO|JT(?:Express)?|JD|YunExpress|4PX|Yanwen)$/i;

function isPlausibleField(key: string, value: string): boolean {
  const v = String(value ?? "").trim();
  if (!v) return false;
  if (
    /^(n\/?a|none|null|undefined|unknown|未知|无|暂无|不清楚|not\s*available|-|—|–|\.)$/i
      .test(v)
  ) {
    return false;
  }

  switch (key) {
    case "Product Name": {
      if (v.length > 100) return false;
      if (looksLikeSentence(v)) return false;
      if (looksLikeNonProductName(v)) return false;
      if (
        /^(?:实验室(?:检测|测试)?|检测服务|Lab(?:oratory)?\s*(?:testing|test)?|PSI|Inspection|Testing|EN\s*71|CPSIA)$/i
          .test(v)
      ) {
        return false;
      }
      const cleaned = cleanProductName(v);
      if (!cleaned || cleaned.length < 2) return false;
      if (looksLikeNonProductName(cleaned)) return false;
      if (cleaned.length > 80) return false;
      const hasCjk = /[\u4e00-\u9fff]/.test(cleaned);
      if (!hasCjk && countWords(cleaned) > 8) return false;
      if (hasCjk && cleaned.length > 28) return false;
      return true;
    }
    case "Program": {
      if (/^__PROGRAM_(?:TEMU_HW|TEMU_TOY)__$/.test(v)) return true;
      if (v.length > 120 || looksLikeSentence(v)) return false;
      return !!resolveProgramLabel(v);
    }
    case "Country of Origin": {
      if (v.length > 40 || looksLikeSentence(v)) return false;
      const originNorm = normalizeOrigin(v);
      if (KNOWN_ORIGIN_RE.test(originNorm) || KNOWN_ORIGIN_RE.test(v)) {
        return true;
      }
      if (/[\u4e00-\u9fff]/.test(v)) {
        return v.length >= 2 && v.length <= 12 && !looksLikeAddress(v);
      }
      return countWords(v) <= 3 && /^[A-Za-z][A-Za-z\s\-.]{1,35}$/.test(v);
    }
    case "Countries/Regions of Distribution": {
      if (v.length > 80 || looksLikeSentence(v)) return false;
      const parts = v.split(/[,，、;/|]+/).map((p) => p.trim()).filter(Boolean);
      if (!parts.length) return false;
      let ok = 0;
      for (const p of parts) {
        if (
          KNOWN_REGION_TOKEN_RE.test(p) || KNOWN_ORIGIN_RE.test(p) ||
          (p.length <= 12 && /[\u4e00-\u9fffA-Za-z]/.test(p))
        ) {
          ok += 1;
        }
      }
      return ok > 0 && ok >= Math.ceil(parts.length / 2);
    }
    case "Item#/model#": {
      if (v.length > 40 || looksLikeSentence(v) || looksLikeAddress(v)) {
        return false;
      }
      if (/^(?:No\.?|Number|#|N\/A)$/i.test(v)) return false;
      const compact = v.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9][A-Za-z0-9\-_.\/#]{0,38}$/.test(compact)) {
        if (
          !/^[A-Za-z0-9][A-Za-z0-9\-_.\/# ]{1,38}$/.test(v) ||
          countWords(v) > 3
        ) {
          return false;
        }
      }
      if (/^(?:Manufacturer|Address|Rating|Made|China|Product)$/i.test(v)) {
        return false;
      }
      return true;
    }
    case "Manufacturer": {
      if (v.length > 80 || looksLikeSentence(v)) return false;
      if (/^MADE\s+IN\b/i.test(v)) return false;
      if (looksLikeTracking(v)) return false;
      if (/\d+\s*V|\d+\s*W|\d+\s*Hz|^Rating\b/i.test(v)) return false;
      return looksLikeCompanyName(v);
    }
    case "Manufacturer Address": {
      if (v.length > 160) return false;
      if (v.length < 6) return false;
      if (/^(?:Manufacturer|Model|Rating|Contact|Company)$/i.test(v)) {
        return false;
      }
      if (looksLikeTracking(v)) return false;
      if (looksLikeAddress(v)) return true;
      if (looksLikeSentence(v)) return false;
      if (/[\u4e00-\u9fff]/.test(v) && v.length >= 8) return true;
      return v.length >= 12 && countWords(v) >= 2;
    }
    case "Sample Collection Method": {
      if (/^__SAMPLE_(?:SHIP|COLLECT|RECEIVED)__$/.test(v)) return true;
      if (v.length > 80 || looksLikeSentence(v)) return false;
      return /(?:寄送|邮寄|送样|现场收集|上门取样|已经拿到|已收到|仓库|ship|collect|received|courier|mail\s*sample)/i
        .test(v);
    }
    case "Electric Product": {
      if (/^__ELECTRIC_(?:YES|NO)__$/.test(v)) return true;
      if (
        /^(?:带电产品|非电产品|带电|非电|electric|non[-\s]?electric|yes|no)$/i
          .test(v)
      ) {
        return true;
      }
      return false;
    }
    case "Product Description": {
      if (v.length > 200 || looksLikeSentence(v)) return false;
      if (/额定|Rating|Rated|\d+\s*[VvWw]|\d+\s*Hz|电池|充电|Input|Output|电压|功率/.test(v)) {
        return true;
      }
      return v.length >= 2 && v.length <= 120 && countWords(v) <= 25;
    }
    case "Carrier": {
      if (v.length > 40 || looksLikeSentence(v)) return false;
      if (looksLikeTracking(v) && !KNOWN_CARRIER_RE.test(v)) return false;
      if (KNOWN_CARRIER_RE.test(v)) return true;
      return countWords(v) <= 4 && /[\u4e00-\u9fffA-Za-z]/.test(v) &&
        !/^\d+$/.test(v);
    }
    case "Tracking Number": {
      if (looksLikeSentence(v) || looksLikeAddress(v)) return false;
      const tr = v.replace(/[\s\-]/g, "");
      if (tr.length < 8 || tr.length > 32) return false;
      if (!/^[A-Za-z0-9]+$/.test(tr)) return false;
      if (/^(?:toy|fan|robot|product|china|made)/i.test(tr)) return false;
      return looksLikeTracking(v) ||
        (/[A-Za-z]/.test(tr) && /\d/.test(tr)) ||
        /^\d{10,22}$/.test(tr);
    }
    case "Shipping Remark": {
      if (v.length > 240) return false;
      if (
        looksLikeSentence(v) &&
        !/(?:批号|生产日期|欧代|合规标识|\bCE\b|\bUKCA\b|\bFCC\b|\bRoHS\b|Batch|Remark)/i
          .test(v)
      ) {
        return false;
      }
      return true;
    }
    default:
      return v.length > 0 && v.length <= 200 && !looksLikeSentence(v);
  }
}

function sanitizeParsedFields(
  fields: FieldMap,
  opts?: { rawExcerpt?: string },
): FieldMap {
  const out: FieldMap = {};
  for (const key of FIELD_KEYS) {
    out[key] = "";
  }
  const src = fields || {};
  for (const key of FIELD_KEYS) {
    let raw = String(src[key] || "").trim();
    if (!raw) continue;
    let candidate = raw;
    if (key === "Product Name") {
      candidate = cleanProductName(raw) || "";
    } else if (key === "Country of Origin") {
      candidate = normalizeOrigin(raw) || raw;
    } else if (key === "Program") {
      candidate = resolveProgramLabel(raw) || "";
    } else if (key === "Electric Product") {
      const elecLower = String(candidate || "").toLowerCase();
      const saysYes = /__ELECTRIC_YES__|带电产品|带电|electric|yes/i.test(elecLower);
      const saysNo = /__ELECTRIC_NO__|非电产品|非电|non[-\s]?electric|no/i.test(elecLower);
      if (saysYes && !saysNo) {
        candidate = hasElectricEvidence(opts?.rawExcerpt || "") ? "__ELECTRIC_YES__" : "";
      } else if (saysNo && !saysYes) {
        candidate = "__ELECTRIC_NO__";
      } else {
        candidate = "";
      }
    }
    if (!candidate || !isPlausibleField(key, candidate)) {
      out[key] = "";
      continue;
    }
    if (key === "Product Name") {
      const cleaned = cleanProductName(candidate) || candidate;
      out[key] = isPlausibleField(key, cleaned) ? cleaned : "";
    } else if (key === "Program") {
      out[key] = resolveProgramLabel(candidate) || "";
    } else {
      out[key] = candidate;
    }
  }

  ensureProgramMatched(out, { rawExcerpt: opts?.rawExcerpt || "" });

  if (opts?.rawExcerpt && out["Shipping Remark"]) {
    const excerpt = String(opts.rawExcerpt || "").replace(/\s+/g, " ").trim()
      .toLowerCase();
    const remark = out["Shipping Remark"].replace(/\s+/g, " ").trim()
      .toLowerCase();
    if (excerpt.length > 40 && remark.length > 40) {
      const overlap =
        excerpt.indexOf(remark.slice(0, Math.min(40, remark.length))) !== -1 ||
        remark.indexOf(excerpt.slice(0, Math.min(40, excerpt.length))) !== -1;
      const hasBetter = !!(
        out["Product Name"] || out["Manufacturer"] || out["Item#/model#"] ||
        out["Country of Origin"]
      );
      if (
        overlap && hasBetter &&
        !/(?:批号|生产日期|欧代|合规标识|\bce\b|\bukca\b|\bfcc\b|batch)/i.test(remark)
      ) {
        out["Shipping Remark"] = "";
      }
    }
  }

  if (out["Product Description"] && out["Product Description"].length > 200) {
    out["Product Description"] = out["Product Description"].slice(0, 200).trim();
  }
  if (out["Shipping Remark"] && out["Shipping Remark"].length > 240) {
    out["Shipping Remark"] = out["Shipping Remark"].slice(0, 240).trim();
  }
  return out;
}

function isEmptyishField(val: unknown): boolean {
  const s = String(val ?? "").trim();
  if (!s) return true;
  return /^(n\/?a|none|null|undefined|unknown|未知|无|暂无|不清楚|not\s*available|-|—|–|\.)$/i
    .test(s);
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

function lettersOnlyKey(key: string): string {
  return String(key || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

/** OCR/LLM often misspells Manufacturer → manufatcurer, manufactuer, etc. */
function looksLikeManufacturerKeyToken(token: string): boolean {
  const n = lettersOnlyKey(token);
  if (!n || n.length < 6 || n.length > 22) return false;
  if (
    /address|addr|地址|厂址|产地|origin|model|product|program|carrier|tracking|sample|electric|region|country|remark|shipping/
      .test(n)
  ) {
    return false;
  }
  if (
    n === "manufacturer" || n === "manufacturers" || n === "manufacturedby" ||
    n === "manufactory" || n === "mfr" || n === "mfg"
  ) {
    return true;
  }
  if (/manufactur/.test(n) || /manufatur/.test(n)) return true;
  if (/manuf/.test(n) && editDistance(n, "manufacturer") <= 3) return true;
  return editDistance(n, "manufacturer") <= 3;
}

function looksLikeManufacturerAddressKeyToken(token: string): boolean {
  const raw = String(token || "");
  const n = lettersOnlyKey(token);
  if (/制造商地址|工厂地址|厂家地址|厂址/.test(raw)) return true;
  if (!n) return false;
  if (/(manufacturer|manufactur|manufatcur|manufatur).{0,6}(address|addr)/.test(n)) {
    return true;
  }
  if (/(address|addr).{0,6}(manufacturer|manufactur)/.test(n)) return true;
  return false;
}

function resolveCanonicalFieldKey(
  key: string,
): (typeof FIELD_KEYS)[number] | "" {
  const raw = String(key || "").trim();
  if (!raw) return "";
  if ((FIELD_KEYS as readonly string[]).includes(raw)) {
    return raw as (typeof FIELD_KEYS)[number];
  }
  const alias: Record<string, (typeof FIELD_KEYS)[number]> = {
    "product name": "Product Name",
    product_name: "Product Name",
    productname: "Product Name",
    品名: "Product Name",
    产品名称: "Product Name",
    program: "Program",
    关联项目: "Program",
    "country of origin": "Country of Origin",
    country_of_origin: "Country of Origin",
    origin: "Country of Origin",
    "made in": "Country of Origin",
    原产国: "Country of Origin",
    原产国家或地区: "Country of Origin",
    产地: "Country of Origin",
    "countries/regions of distribution": "Countries/Regions of Distribution",
    "countries of distribution": "Countries/Regions of Distribution",
    distribution: "Countries/Regions of Distribution",
    "sales regions": "Countries/Regions of Distribution",
    销售国家或地区: "Countries/Regions of Distribution",
    "item#/model#": "Item#/model#",
    "item # / model #": "Item#/model#",
    "item/model": "Item#/model#",
    item_model: "Item#/model#",
    model: "Item#/model#",
    "model no": "Item#/model#",
    "model no.": "Item#/model#",
    "model number": "Item#/model#",
    "model#": "Item#/model#",
    sku: "Item#/model#",
    "p/n": "Item#/model#",
    pn: "Item#/model#",
    型号: "Item#/model#",
    货号: "Item#/model#",
    "货号 / 型号": "Item#/model#",
    manufacturer: "Manufacturer",
    "manufacturer name": "Manufacturer",
    manufacturer_name: "Manufacturer",
    manufacturers: "Manufacturer",
    manufactory: "Manufacturer",
    "manufactured by": "Manufacturer",
    manufactured_by: "Manufacturer",
    manufactuer: "Manufacturer",
    manufatcurer: "Manufacturer",
    manufaturer: "Manufacturer",
    manufacturor: "Manufacturer",
    manfuacturer: "Manufacturer",
    mfr: "Manufacturer",
    mfg: "Manufacturer",
    company: "Manufacturer",
    "company name": "Manufacturer",
    factory: "Manufacturer",
    "factory name": "Manufacturer",
    制造商: "Manufacturer",
    生产商: "Manufacturer",
    厂家: "Manufacturer",
    厂商: "Manufacturer",
    生产厂家: "Manufacturer",
    工厂: "Manufacturer",
    "manufacturer address": "Manufacturer Address",
    manufacturer_address: "Manufacturer Address",
    manufactueraddress: "Manufacturer Address",
    manufatcureraddress: "Manufacturer Address",
    address: "Manufacturer Address",
    "factory address": "Manufacturer Address",
    制造商地址: "Manufacturer Address",
    厂址: "Manufacturer Address",
    工厂地址: "Manufacturer Address",
    厂家地址: "Manufacturer Address",
    地址: "Manufacturer Address",
    "sample collection method": "Sample Collection Method",
    "sample collection": "Sample Collection Method",
    样品收集方式: "Sample Collection Method",
    "electric product": "Electric Product",
    "electrical product": "Electric Product",
    产品是否带电: "Electric Product",
    "product description": "Product Description",
    rating: "Product Description",
    产品说明: "Product Description",
    carrier: "Carrier",
    快递公司: "Carrier",
    "tracking number": "Tracking Number",
    "tracking no": "Tracking Number",
    运单号: "Tracking Number",
    "shipping remark": "Shipping Remark",
    remark: "Shipping Remark",
    remarks: "Shipping Remark",
    备注: "Shipping Remark",
    物流备注: "Shipping Remark",
  };
  const hit = alias[raw.toLowerCase()];
  if (hit) return hit;
  if (looksLikeManufacturerAddressKeyToken(raw)) return "Manufacturer Address";
  if (looksLikeManufacturerKeyToken(raw)) return "Manufacturer";
  if (/制造[商厂家]|生产商|厂商|厂家/.test(raw) && !/地址|addr/i.test(raw)) {
    return "Manufacturer";
  }
  return "";
}

function cleanManufacturerValue(raw: string): string {
  let v = String(raw || "").replace(/\s+/g, " ").trim();
  if (!v) return "";
  v = v.replace(
    /^(?:Manufacturer|Manufactured\s+by|Made\s+by|Factory|Company|制造商|生产商|厂家|厂商)\s*[:：#.=-]?\s*/i,
    "",
  );
  v = v.split(
    /\s+(?:Address|Contact|EC\s*REP|UK\s*REP|Rating|Model|MADE\s+IN|制造商地址|厂址|地址)\b/i,
  )[0].trim();
  v = v.replace(/[,，;；]\s*$/, "").trim();
  if (/^(Address|Model|Rating|Contact|Company|Manufacturer)$/i.test(v)) return "";
  return v;
}

/** Map alternate vision/LLM keys onto canonical FIELD_KEYS. */
function canonicalizeFieldMap(
  raw: Record<string, unknown> | null | undefined,
): FieldMap {
  const out: FieldMap = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    if (isEmptyishField(value)) continue;
    let text = String(value).trim();
    const canon = resolveCanonicalFieldKey(key);
    if (!canon) continue;
    if (canon === "Manufacturer") {
      text = cleanManufacturerValue(text) || text;
    }
    if (!out[canon]) out[canon] = text;
  }
  return out;
}

function normalizeOrigin(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  const low = s.toLowerCase();
  if (
    low.includes("china") ||
    s.includes("中国") ||
    /\bcn\b/i.test(s) ||
    low.includes("p.r.c") ||
    low.includes("prc") ||
    low.includes("made in china")
  ) {
    return "中国";
  }
  if (low.includes("vietnam") || s.includes("越南")) return "越南";
  if (low.includes("india") || s.includes("印度")) return "印度";
  if (low.includes("aland") || low.includes("åland") || s.includes("奥兰")) {
    return "奥兰群岛";
  }
  return s.replace(/^made\s+in\s+/i, "").trim();
}

function regionsFromMarks(marks: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  if (!marks) return found;
  const items = Array.isArray(marks)
    ? marks
    : String(marks).split(/[,，/\s]+/);
  for (const item of items) {
    let key = String(item || "").trim().toUpperCase().replace(/\./g, "");
    if (!key || key === "ROHS") continue;
    let regions = MARK_TO_REGIONS[key] ||
      MARK_TO_REGIONS[key.replace("MARK", "")];
    if (!regions && key.includes("UKCA")) regions = MARK_TO_REGIONS.UKCA;
    if (!regions && (key === "CE" || key === "ＣＥ")) {
      regions = MARK_TO_REGIONS.CE;
    }
    if (!regions) continue;
    for (const region of regions) {
      if (!seen.has(region)) {
        seen.add(region);
        found.push(region);
      }
    }
  }
  return found;
}

function mergeRegionList(...parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const mapping: Record<string, string> = {
    "european union": "欧盟",
    eu: "欧盟",
    europe: "欧盟",
    "united states": "美国",
    usa: "美国",
    us: "美国",
    "u.s.a": "美国",
    "u.s.": "美国",
    "united kingdom": "英国",
    uk: "英国",
    "great britain": "英国",
    australia: "澳大利亚",
    canada: "加拿大",
    "south africa": "南非",
    china: "中国",
  };
  for (const part of parts) {
    if (!part) continue;
    for (const token of String(part).split(/[,，、;/|]+/)) {
      let region = token.trim();
      if (!region) continue;
      region = mapping[region.toLowerCase()] || region;
      if (!seen.has(region)) {
        seen.add(region);
        out.push(region);
      }
    }
  }
  return out.join("、");
}

function buildShippingRemark(extra: Record<string, unknown>): string {
  const bits: string[] = [];
  const batch = String(extra.Batch || extra.batch || "").trim();
  const date = String(
    extra["Date of manufacture"] ||
      extra["Manufacture Date"] ||
      extra.date ||
      "",
  ).trim();
  const ec = String(extra["EC REP"] || extra.ec_rep || "").trim();
  const marks = extra.marks || extra.compliance_marks || [];
  const marksS = Array.isArray(marks)
    ? marks.map((m) => String(m).trim()).filter(Boolean).join("、")
    : String(marks || "").trim();
  if (batch) bits.push(`批号：${batch}`);
  if (date) bits.push(`生产日期：${date}`);
  if (ec) bits.push(`欧代：${ec}`);
  if (marksS) bits.push(`合规标识：${marksS}`);
  return bits.join("；");
}

async function extractDocx(data: Uint8Array): Promise<string> {
  const JSZip = (await import("https://esm.sh/jszip@3.10.1")).default;
  const zip = await JSZip.loadAsync(data);
  const file = zip.file("word/document.xml");
  if (!file) return "";
  const xml = await file.async("string");
  return xml
    .replace(/<w:tab[^/]*\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPdf(data: Uint8Array): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import(
      "https://esm.sh/unpdf@0.12.1"
    );
    const pdf = await getDocumentProxy(data);
    const { text } = await extractText(pdf, { mergePages: true });
    return String(text || "").trim();
  } catch (err) {
    console.error("pdf extract failed", err);
    return "";
  }
}

/** Pull embedded JPEG/PNG streams from scanned PDFs when text layer is empty. */
function extractEmbeddedImagesFromPdf(
  data: Uint8Array,
): { mime: string; bytes: Uint8Array }[] {
  const out: { mime: string; bytes: Uint8Array }[] = [];
  const minBytes = 12_000;
  for (let i = 0; i < data.length - 3; i++) {
    // JPEG SOI
    if (data[i] === 0xff && data[i + 1] === 0xd8 && data[i + 2] === 0xff) {
      for (let j = i + 3; j < data.length - 1; j++) {
        if (data[j] === 0xff && data[j + 1] === 0xd9) {
          const bytes = data.slice(i, j + 2);
          if (bytes.length >= minBytes) {
            out.push({ mime: "image/jpeg", bytes });
          }
          i = j + 1;
          break;
        }
      }
      continue;
    }
    // PNG signature
    if (
      data[i] === 0x89 &&
      data[i + 1] === 0x50 &&
      data[i + 2] === 0x4e &&
      data[i + 3] === 0x47
    ) {
      const iend = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
      for (let j = i + 8; j < data.length - 8; j++) {
        let match = true;
        for (let k = 0; k < 8; k++) {
          if (data[j + k] !== iend[k]) {
            match = false;
            break;
          }
        }
        if (match) {
          const bytes = data.slice(i, j + 8);
          if (bytes.length >= minBytes) {
            out.push({ mime: "image/png", bytes });
          }
          i = j + 7;
          break;
        }
      }
    }
  }
  out.sort((a, b) => b.bytes.length - a.bytes.length);
  // Dedupe near-identical sizes (same image repeated)
  const uniq: { mime: string; bytes: Uint8Array }[] = [];
  for (const img of out) {
    if (uniq.some((u) => Math.abs(u.bytes.length - img.bytes.length) < 64)) {
      continue;
    }
    uniq.push(img);
    if (uniq.length >= 3) break;
  }
  return uniq;
}

function extractPlain(data: Uint8Array): string {
  const encodings: string[] = ["utf-8", "gb18030", "latin-1"];
  for (const enc of encodings) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(data);
    } catch {
      /* try next */
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(data);
}

async function ocrImageStructured(
  data: Uint8Array,
  mime: string,
  _filename: string,
): Promise<Record<string, unknown>> {
  const b64 = bytesToBase64(data);
  let media = mime.startsWith("image/") ? mime : "image/jpeg";
  if (media === "application/octet-stream") media = "image/jpeg";
  const prompt =
    "你是产品标签/合格证/铭牌识别助手。请仔细阅读图片中的全部文字与标识，" +
    "抽取检测下单所需字段，只返回合法 JSON（不要 markdown）。\n" +
    "字段说明：\n" +
    '- "Product Name": 简短产品名称 ONLY（如 Electric Fan、直发器、智能机器人玩具）。' +
    '中文规格表里「名称」后的值才是品名（如 名称：直发器）；不要填型号 HT060、规格 220V/50Hz、标准 EN60335、水印网址。' +
    '不要整句、不要「实验室检测 · xxx」、不要销往/制造商/型号后缀。从语音长句中只抠出品名\n' +
    '- "Item#/model#": 型号/货号，优先取 Model / Model No / 型号 / SKU / Item No / P/N（如 HT060、XP-085）。键名必须是 Item#/model#，不要用 Model\n' +
    '- "Manufacturer": 制造商公司全称。标签上可能写作 Manufacturer / Manufactured by / Manufatcurer(拼写错误) / Company / Factory / 制造商 / 生产商 / 厂家——一律填到键名 "Manufacturer"（不要用别的键名）\n' +
    '- "Manufacturer Address": 制造商地址完整一行（Address / 厂址）；不要把欧代地址当作制造商地址；键名必须是 "Manufacturer Address"\n' +
    '- "Country of Origin": 原产国（优先 MADE IN / Manufacturing location，值用简体如「中国」）\n' +
    '- "Batch": 批号/Batch\n' +
    '- "Date of manufacture": 生产日期\n' +
    '- "Rating": 额定参数原文（如 110/240~, 50/60Hz, 60W）\n' +
    '- "Electric Product": 是否带电，填「带电产品」「非电产品」或空字符串。' +
    "只有当资料里明确出现电压/功率/Hz/电池/充电/电机/电源/Rating/Input/Output 等带电信息时才填「带电产品」；" +
    "不要凭品名(风扇/机器人/玩具等)猜测。没有明确带电信息则留空字符串，不要填非电也不要填带电。\n" +
    '- "Product Description": 带电说明，可写入 Rating / 电池 / 充电方式\n' +
    '- "EC REP": 欧代公司+地址（如有 EC REP）\n' +
    '- "UK REP": 英代（如有）\n' +
    '- "marks": 图片上出现的合规标识数组，可能含 CE, UKCA, FC, FCC, RoHS, WEEE 等\n' +
    '- "Countries/Regions of Distribution": 销售国家/地区；' +
    "若未写明，则根据标识/代表处推断：CE/EC REP/Triman→欧盟，UKCA/UK REP→英国，FC/FCC→美国，CCC→中国，RCM→澳大利亚\n" +
    '- "ocr_text": 关键可见关键文字要点（简体）\n' +
    "无法确定的字段用空字符串；marks 用数组。";

  const raw = await nvidiaChat({
    model: VISION_MODEL,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:${media};base64,${b64}` },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
    // Keep tokens modest — latency on NIM vision is dominated by output size
    max_tokens: 900,
    temperature: 0.05,
    stream: false,
  });
  try {
    return parseJsonFromLlm(raw);
  } catch {
    return { ocr_text: raw, marks: [] };
  }
}

function labelDictToSnippet(
  label: Record<string, unknown>,
  filename: string,
): string {
  const lines = [`【产品标签识别: ${filename}】`];
  for (
    const key of [
      "Product Name",
      "Item#/model#",
      "Manufacturer",
      "Manufacturer Address",
      "Country of Origin",
      "Countries/Regions of Distribution",
      "Batch",
      "Date of manufacture",
      "EC REP",
      "UK REP",
      "Rating",
      "Electric Product",
      "Product Description",
      "ocr_text",
    ]
  ) {
    const val = label[key];
    if (val) lines.push(`${key}: ${val}`);
  }
  const marks = label.marks || [];
  if (Array.isArray(marks) && marks.length) {
    lines.push("marks: " + marks.map(String).join(", "));
  }
  return lines.join("\n");
}

async function extractFile(
  filename: string,
  mime: string,
  data: Uint8Array,
): Promise<{ text: string; label: Record<string, unknown> | null }> {
  const lower = filename.toLowerCase();
  try {
    if (isImage(filename, mime)) {
      const label = await ocrImageStructured(data, mime, filename);
      return { text: labelDictToSnippet(label, filename), label };
    }
    if (mime === "application/pdf" || lower.endsWith(".pdf")) {
      const text = await extractPdf(data);
      if (text && text.length >= 30) {
        return { text: `【文件: ${filename}】\n${text}`, label: null };
      }
      // Scanned / image-only PDF: OCR embedded page images via vision
      const embeds = extractEmbeddedImagesFromPdf(data);
      if (embeds.length) {
        const snippets: string[] = [];
        let firstLabel: Record<string, unknown> | null = null;
        for (let i = 0; i < embeds.length; i++) {
          const emb = embeds[i];
          const pageName = `${filename}#img${i + 1}`;
          const label = await ocrImageStructured(emb.bytes, emb.mime, pageName);
          if (!firstLabel) firstLabel = label;
          snippets.push(labelDictToSnippet(label, pageName));
        }
        return {
          text: snippets.join("\n\n"),
          label: firstLabel,
        };
      }
      return {
        text: `[PDF ${filename}: 扫描件无文本层且未能抽出页面图，请在客户端转图后重试或直接上传照片]`,
        label: null,
      };
    }
    if (
      mime.includes("wordprocessingml") ||
      lower.endsWith(".docx") ||
      lower.endsWith(".doc")
    ) {
      if (lower.endsWith(".docx") || mime.includes("wordprocessingml")) {
        const text = await extractDocx(data);
        return { text: `【文件: ${filename}】\n${text}`, label: null };
      }
      return { text: `[Word ${filename}: 仅支持 .docx]`, label: null };
    }
    if (mime.startsWith("text/") || /\.(txt|csv|md)$/i.test(lower)) {
      return {
        text: `【文件: ${filename}】\n${extractPlain(data)}`,
        label: null,
      };
    }
  } catch (exc) {
    return { text: `[${filename}: 提取失败 ${exc}]`, label: null };
  }
  return {
    text: `[${filename}: 暂不支持的格式，请上传图片/PDF/DOCX]`,
    label: null,
  };
}

function seedFieldsFromLabels(
  labels: Record<string, unknown>[],
): FieldMap {
  const seed: FieldMap = Object.fromEntries(FIELD_KEYS.map((k) => [k, ""]));
  const remarkBits: string[] = [];
  const regions: string[] = [];
  for (const label of labels) {
    const flat = canonicalizeFieldMap(label);
    for (
      const key of [
        "Product Name",
        "Item#/model#",
        "Manufacturer",
        "Manufacturer Address",
      ] as const
    ) {
      const val = String(flat[key] || "").trim();
      if (val && !seed[key]) {
        seed[key] = key === "Product Name" ? (cleanProductName(val) || "") : val;
      }
    }
    const origin = normalizeOrigin(String(flat["Country of Origin"] || ""));
    if (origin && !seed["Country of Origin"]) {
      seed["Country of Origin"] = origin;
    }
    regions.push(String(flat["Countries/Regions of Distribution"] || ""));
    regions.push(...regionsFromMarks(label.marks));
    if (String(label["EC REP"] || "").trim()) regions.push("欧盟");
    if (String(label["UK REP"] || "").trim()) regions.push("英国");

    const elec = String(flat["Electric Product"] || "").trim();
    const ratingForElec = String(
      flat["Product Description"] || label.Rating || "",
    ).trim();
    const labelElecEvidence = hasElectricEvidence(
      [ratingForElec, label.Rating, label["Product Description"], label["ocr_text"]].join("\n"),
    );
    if (elec && !seed["Electric Product"]) {
      if (/非电|non[-\s]?electric|no/i.test(elec)) {
        seed["Electric Product"] = "非电产品";
      } else if (/带电|electric|yes/i.test(elec) && labelElecEvidence) {
        seed["Electric Product"] = "带电产品";
      }
    }
    const rating = ratingForElec;
    if (rating && !seed["Product Description"]) {
      seed["Product Description"] = rating.startsWith("额定")
        ? rating
        : /V|W|Hz|电池|充电|Rated|Rating/i.test(rating)
        ? `额定：${rating}`
        : rating;
      if (
        !seed["Electric Product"] &&
        /\d+\s*V|\d+\s*W|\d+\s*Hz|电池|充电|Electric/i.test(rating)
      ) {
        seed["Electric Product"] = "带电产品";
      }
    }
    if (!seed.Program) {
      const hintBlob = [
        seed["Product Name"],
        seed["Product Description"],
        seed["Electric Product"],
        String(label.ocr_text || ""),
      ].join("\n");
      seed.Program = matchProgramFromText(hintBlob, {
        productName: seed["Product Name"] || "",
        electricYes: /带电|electric/i.test(seed["Electric Product"] || ""),
      });
    }
    const extraRemark = buildShippingRemark(label);
    if (extraRemark) remarkBits.push(extraRemark);
  }
  seed["Countries/Regions of Distribution"] = mergeRegionList(...regions);
  if (remarkBits.length && !seed["Shipping Remark"]) {
    seed["Shipping Remark"] = remarkBits.join("；");
  }
  return seed;
}

function normalizeResult(
  parsed: Record<string, unknown>,
  seedFields: FieldMap,
): Record<string, unknown> {
  const fieldsInRaw =
    parsed.fields && typeof parsed.fields === "object"
      ? parsed.fields as Record<string, unknown>
      : {};
  const fieldsIn = canonicalizeFieldMap(fieldsInRaw);
  let fields: FieldMap = {};
  for (const key of FIELD_KEYS) {
    let val = fieldsIn[key];
    if (isEmptyishField(val)) val = seedFields[key] || "";
    fields[key] = val != null ? String(val).trim() : "";
  }
  if (fields["Product Name"]) {
    fields["Product Name"] = cleanProductName(fields["Product Name"]) || "";
  }
  if (fields["Country of Origin"]) {
    fields["Country of Origin"] = normalizeOrigin(fields["Country of Origin"]);
  }
  if (fields.Program) {
    fields.Program = resolveProgramLabel(fields.Program) || fields.Program;
  }
  fields["Countries/Regions of Distribution"] = mergeRegionList(
    seedFields["Countries/Regions of Distribution"] || "",
    fields["Countries/Regions of Distribution"] || "",
  );
  if (!fields["Shipping Remark"] && seedFields["Shipping Remark"]) {
    fields["Shipping Remark"] = seedFields["Shipping Remark"];
  } else if (fields["Shipping Remark"] && seedFields["Shipping Remark"]) {
    if (!fields["Shipping Remark"].includes(seedFields["Shipping Remark"])) {
      fields["Shipping Remark"] += "；" + seedFields["Shipping Remark"];
    }
  }
  // Prefer richer seed Manufacturer / Model / Address when LLM left them blankish
  for (
    const key of [
      "Item#/model#",
      "Manufacturer",
      "Manufacturer Address",
      "Electric Product",
      "Product Description",
    ] as const
  ) {
    if (isEmptyishField(fields[key]) && seedFields[key]) {
      fields[key] = seedFields[key];
    }
  }

  const excerpt = String(parsed.raw_excerpt || "").slice(0, 500);
  // Plausibility gate — drop clearly unreasonable OCR/LLM junk per field
  fields = sanitizeParsedFields(fields, { rawExcerpt: excerpt });

  const summaryIn =
    parsed.product_summary && typeof parsed.product_summary === "object"
      ? parsed.product_summary as Record<string, unknown>
      : {};
  let summaryName = String(summaryIn.name || fields["Product Name"] || "").trim();
  summaryName = cleanProductName(summaryName) || "";
  if (summaryName && !isPlausibleField("Product Name", summaryName)) {
    summaryName = "";
  }
  if (!summaryName) summaryName = fields["Product Name"] || "";
  const productSummary = {
    name: summaryName,
    brand: String(summaryIn.brand || "").trim(),
    hint: String(summaryIn.hint || "").trim(),
  };
  const confidence =
    parsed.confidence && typeof parsed.confidence === "object"
      ? parsed.confidence
      : {};

  return {
    product_summary: productSummary,
    fields,
    confidence,
    raw_excerpt: excerpt,
  };
}

async function structureFields(
  context: string,
  seedFields: FieldMap,
): Promise<Record<string, unknown>> {
  const fieldList = FIELD_KEYS.map((k) => `- "${k}"`).join("\n");
  const system =
    "你是 QIMA 检测订单信息抽取助手。根据用户提供的语音、文档、产品标签识别结果和商品链接网页内容，" +
    "抽取订单字段。必须输出合法 JSON，不要 markdown。字段值可用简体中文或与原文一致的英文品名。\n" +
    "规则：\n" +
    "0) 多源合并（重要）：若同时有【语音转写】【商品链接网页内容】与上传图片/文档，必须交叉填表——" +
    "每个字段取最合理的来源，不要只用单一资料；标签 OCR/规格表优先于网页营销文案，" +
    "语音可补充销售国家、样品方式、承运商等网页里没有的信息；冲突时选更完整、更像工厂法定信息的值。" +
    "若资料含【商品链接网页内容】：标题/品牌/型号/描述映射到对应字段；" +
    "Marketplace 品牌常对应 Manufacturer；ASIN/SKU 可写入 Item#/model#；" +
    "不要把整个商品列表或评论写进任何字段。\n" +
    "1) Product Name：只填简洁产品名（2–8 个英文词或 ≤24 个汉字），例如「Toy Race Car」「直发器」。" +
    "中文表头「名称 / 品名 / 产品名称」后的值才是品名；禁止填型号码（HT060）、电气规格（220Vac 50Hz 25W）、" +
    "标准号（EN60335-1）、水印/网址，或字段标签本身。" +
    "禁止整句语音、禁止「Lab testing · … / 实验室检测 · …」、禁止带上 sold in / manufactured by / 销往 / 制造商 / 型号等从句。" +
    "从 rambling 语音中智能抠出品名，其余信息分别写入对应字段。不确定则留空。\n" +
    "2) Country of Origin：MADE IN CHINA / Manufacturing location 含 China →「中国」\n" +
    "3) Countries/Regions of Distribution：CE/EC REP/Triman→欧盟，UKCA/UK REP→英国，" +
    "FC/FCC→美国；多个用顿号「、」连接\n" +
    "4) Item#/model# 取 Model / Model No / 型号 / SKU / 货号（如 HT060）；不要把 NO/Number 或品名当型号\n" +
    "5) Electric Product：只有资料里明确出现电压/功率/Hz/电池/充电/电机/电源/Rating/Input/Output 等带电信息时才填「带电产品」；" +
    "明确写出非电/无电池才填「非电产品」；否则留空字符串。不要凭品名(风扇/机器人/玩具)猜测带电。\n" +
    "6) Product Description：带电时写入 Rating/电池/充电等要点\n" +
    "7) Shipping Remark 可汇总批号、生产日期、欧代、合规标识\n" +
    "8) Program：只能从下列固定列表中选择完整字符串之一，禁止自创：" +
    PROGRAM_CATALOG.map((p) => `「${p}」`).join("、") +
    "。根据品名/品类推断：玩具→Toys，睡衣→Textile Sleepwear，纺织/面料非睡衣→Textile Non-Sleepwear，" +
    "食品接触/餐具/水杯/锅→FCM，眼镜/PPE→Eyewear，电子/电压/风扇→Electric product，杂货/五金工具→Hardware，" +
    "化学品/化妆品/指甲油/香水/油漆/胶水/清洁剂/只做MSDS→MSDS，SH-Self 字样→SH-Self。" +
    "付款方：TEMU Pay / TEMU 付款 vs Seller Pay / 商家付款；未提及付款方时默认 Seller Pay 变体（若该品类有）。" +
    "无法归类或置信度不足时 Program 填 DEFAULT。\n" +
    "9) 无法确定或明显不合理的字段留空字符串，不要编造、不要把整段语音塞进任一字段\n" +
    'JSON：{"product_summary":{"name":"短品名","brand":"","hint":""},' +
    '"fields":{...},"confidence":{...},"raw_excerpt":""}';

  const seedNote = Object.values(seedFields).some(Boolean)
    ? "\n\n已从标签直接识别的候选字段（可校对合并）：\n" +
      JSON.stringify(seedFields)
    : "";
  const user =
    `请从以下资料抽取订单字段。\n\n字段列表：\n${fieldList}\n\n` +
    `资料内容：\n${context.slice(0, 24000)}${seedNote}\n\n只返回 JSON。`;

  const raw = await nvidiaChat({
    model: LLM_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.1,
    // Cap output — full catalog already seeded; shorter JSON = faster
    max_tokens: 1400,
  });
  const parsed = parseJsonFromLlm(raw);
  return normalizeResult(parsed, seedFields);
}

function normalizeProductUrl(raw: string): string {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (/^\/\//.test(s)) s = "https:" + s;
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}([/?#]|$)/i.test(s)) s = "https://" + s;
    else return "";
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  if (!u.hostname || u.hostname === "localhost") return "";
  return u.toString();
}

function decodeHtmlEntities(s: string): string {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    )
    .replace(/&nbsp;/gi, " ");
}

function metaContent(html: string, key: string): string {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${k}["'][^>]+content=["']([^"']+)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${k}["']`,
      "i",
    ),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeHtmlEntities(m[1]).trim();
  }
  return "";
}

function stripHtmlToText(html: string): string {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\/?(?:br|p|div|li|tr|h[1-6]|section|article)[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeHtmlEntities(s);
  s = s.replace(/[ \t\f\v]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function extractJsonLdProducts(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const re =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const raw = m[1].replace(/^\s*<!--/, "").replace(/-->\s*$/, "").trim();
      const parsed = JSON.parse(raw);
      const stack: unknown[] = Array.isArray(parsed) ? parsed.slice(0, 20) : [parsed];
      for (let i = 0; i < stack.length && i < 40; i++) {
        const item = stack[i];
        if (!item || typeof item !== "object") continue;
        const node = item as Record<string, unknown>;
        const graph = node["@graph"];
        if (Array.isArray(graph)) {
          for (const g of graph.slice(0, 20)) {
            if (g && typeof g === "object") stack.push(g);
          }
        }
        const type = String(node["@type"] || "").toLowerCase();
        if (type.includes("product") || type.includes("offer")) {
          out.push(node);
        }
      }
    } catch {
      /* ignore bad json-ld */
    }
  }
  return out;
}

type ProductPageSignals = {
  url: string;
  site: string;
  title: string;
  description: string;
  brand: string;
  model: string;
  asin: string;
  text: string;
  source: string;
};

function hostSiteHint(hostname: string): string {
  const h = hostname.toLowerCase();
  if (h.includes("amazon.") || h === "amzn.to" || h.includes("amzn.")) {
    return "amazon";
  }
  if (h.includes("temu.")) return "temu";
  if (h.includes("shopify") || h.includes("myshopify.com")) return "shopify";
  if (h.includes("aliexpress.")) return "aliexpress";
  if (h.includes("ebay.")) return "ebay";
  if (h.includes("walmart.")) return "walmart";
  return h.replace(/^www\./, "");
}

function extractAsin(url: string): string {
  const m = url.match(
    /(?:\/dp\/|\/gp\/product\/|\/product\/|asin=)([A-Z0-9]{8,12})/i,
  );
  return m?.[1] ? m[1].toUpperCase() : "";
}

function signalsFromHtml(html: string, url: string): ProductPageSignals {
  const u = new URL(url);
  const site = hostSiteHint(u.hostname);
  let title =
    metaContent(html, "og:title") ||
    metaContent(html, "twitter:title") ||
    "";
  if (!title) {
    const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (tm?.[1]) title = decodeHtmlEntities(tm[1]).replace(/\s+/g, " ").trim();
  }
  // Amazon often embeds #productTitle even when bot-throttled
  if (!title || site === "amazon") {
    const amz = html.match(
      /id=["']productTitle["'][^>]*>\s*([^<]{2,200})\s*</i,
    );
    if (amz?.[1]) title = decodeHtmlEntities(amz[1]).trim();
  }
  const description =
    metaContent(html, "og:description") ||
    metaContent(html, "description") ||
    metaContent(html, "twitter:description") ||
    "";
  let brand =
    metaContent(html, "product:brand") ||
    metaContent(html, "brand") ||
    "";
  let model = "";
  let desc = description;
  const asin = extractAsin(url);
  const jsonLd = extractJsonLdProducts(html);
  for (const node of jsonLd) {
    if (!title && node.name) title = String(node.name).trim();
    if (!brand && node.brand) {
      const b = node.brand;
      if (typeof b === "string") brand = b;
      else if (b && typeof b === "object" && "name" in (b as object)) {
        brand = String((b as { name?: string }).name || "").trim();
      }
    }
    if (!model && (node.sku || node.mpn || node.model)) {
      model = String(node.sku || node.mpn || node.model || "").trim();
    }
    if (!desc && node.description) {
      desc = String(node.description).replace(/\s+/g, " ").trim();
    }
  }

  // Shopify product JSON
  if ((!title || !brand) && /Shopify\.theme|product":\s*\{/i.test(html)) {
    const shop = html.match(
      /<script[^>]*type=["']application\/json["'][^>]*data-product-json[^>]*>([\s\S]*?)<\/script>/i,
    );
    if (shop?.[1]) {
      try {
        const pj = JSON.parse(shop[1]);
        if (pj.title && !title) title = String(pj.title);
        if (pj.vendor && !brand) brand = String(pj.vendor);
      } catch { /* ignore */ }
    }
  }

  if (site === "amazon" && !brand) {
    const byline = html.match(
      /id=["']bylineInfo["'][^>]*>\s*([^<]{2,80})</i,
    ) || html.match(/Brand\s*:\s*<\/[^>]+>\s*<[^>]+>\s*([^<]{2,80})/i);
    if (byline?.[1]) {
      brand = decodeHtmlEntities(byline[1])
        .replace(/^(?:Visit\s+the|Brand:)\s*/i, "")
        .replace(/\s*Store$/i, "")
        .trim();
    }
  }

  const text = stripHtmlToText(html).slice(0, 12000);
  // Clean Amazon title suffixes
  title = title
    .replace(/\s*[:|]\s*Amazon\.[a-z.]+.*$/i, "")
    .replace(/\s*-\s*TEMU.*$/i, "")
    .trim();

  return {
    url,
    site,
    title,
    description: desc.slice(0, 800),
    brand,
    model: model || asin,
    asin,
    text,
    source: "html",
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchViaJinaReader(url: string): Promise<string> {
  const readerUrl = "https://r.jina.ai/" + url;
  const res = await fetchWithTimeout(
    readerUrl,
    {
      headers: {
        Accept: "text/plain, text/markdown, */*",
        "User-Agent": "QIMA-MiniProgram/1.0 (+product-link-parse)",
      },
      redirect: "follow",
    },
    18000,
  );
  if (!res.ok) throw new Error("jina_http_" + res.status);
  const text = await res.text();
  return String(text || "").trim();
}

async function fetchProductPage(rawLink: string): Promise<ProductPageSignals | null> {
  const url = normalizeProductUrl(rawLink);
  if (!url) return null;

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    "Cache-Control": "no-cache",
  };

  let htmlSignals: ProductPageSignals | null = null;
  try {
    const res = await fetchWithTimeout(
      url,
      { headers, redirect: "follow" },
      15000,
    );
    if (res.ok) {
      const ctype = (res.headers.get("content-type") || "").toLowerCase();
      const html = await res.text();
      if (
        html &&
        (ctype.includes("html") || /<html|<head|<title|og:title/i.test(html))
      ) {
        htmlSignals = signalsFromHtml(html.slice(0, 900000), res.url || url);
      }
    }
  } catch (err) {
    console.warn("direct product fetch failed", err);
  }

  // Enrich / fallback with Jina reader (handles JS-heavy pages better)
  let readerText = "";
  try {
    readerText = await fetchViaJinaReader(url);
  } catch (err) {
    console.warn("jina reader failed", err);
  }

  if (!htmlSignals && !readerText) {
    return {
      url,
      site: hostSiteHint(new URL(url).hostname),
      title: "",
      description: "",
      brand: "",
      model: extractAsin(url),
      asin: extractAsin(url),
      text: "",
      source: "url_only",
    };
  }

  if (!htmlSignals) {
    const titleLine =
      readerText.match(/^(?:Title|标题)\s*:\s*(.+)$/im)?.[1]?.trim() ||
      readerText.split("\n").find((l) => l.trim().length > 8)?.trim() ||
      "";
    return {
      url,
      site: hostSiteHint(new URL(url).hostname),
      title: titleLine.slice(0, 200),
      description: "",
      brand: "",
      model: extractAsin(url),
      asin: extractAsin(url),
      text: readerText.slice(0, 14000),
      source: "jina",
    };
  }

  if (readerText) {
    const mergedText = (htmlSignals.text + "\n\n" + readerText).slice(0, 16000);
    if (!htmlSignals.title) {
      const titleLine =
        readerText.match(/^(?:Title|标题)\s*:\s*(.+)$/im)?.[1]?.trim() || "";
      if (titleLine) htmlSignals.title = titleLine.slice(0, 200);
    }
    htmlSignals.text = mergedText;
    htmlSignals.source = htmlSignals.source + "+jina";
  }
  return htmlSignals;
}

function seedFromProductPage(signals: ProductPageSignals | null): FieldMap {
  const seed: FieldMap = Object.fromEntries(FIELD_KEYS.map((k) => [k, ""]));
  if (!signals) return seed;
  const blob = [signals.title, signals.description, signals.brand, signals.text]
    .filter(Boolean)
    .join("\n");
  if (signals.title) {
    seed["Product Name"] = cleanProductName(signals.title) ||
      signals.title.slice(0, 80);
  }
  if (signals.brand && looksLikeCompanyName(signals.brand)) {
    seed.Manufacturer = cleanManufacturerValue(signals.brand) || signals.brand;
  }
  if (signals.model) seed["Item#/model#"] = String(signals.model).slice(0, 40);
  if (signals.asin && !seed["Item#/model#"]) {
    seed["Item#/model#"] = signals.asin;
  }
  if (signals.description) {
    seed["Product Description"] = signals.description.slice(0, 200);
  }
  // Infer electric / program from page text
  const electricYes =
    /\d+\s*V(?:olt)?|\d+\s*W(?:att)?|\d+\s*Hz|battery|charger|motor|voltage|电源|电机|充电|电池|电压|功率|电子产品|带电|electric\s+(?:fan|product)/i
      .test(blob);
  const electricNo = /非电|non[-\s]?electric|unelectrified/i.test(blob);
  if (electricYes) seed["Electric Product"] = "带电产品";
  else if (electricNo) seed["Electric Product"] = "非电产品";
  const program = matchProgramFromText(blob, {
    productName: seed["Product Name"] || "",
    electricYes: electricYes || /带电|electric/i.test(seed["Electric Product"] || ""),
  });
  if (program) seed.Program = program;

  // Marketplace default distribution
  if (signals.site === "amazon") {
    seed["Countries/Regions of Distribution"] = "美国";
  } else if (signals.site === "temu") {
    seed["Countries/Regions of Distribution"] = "美国";
  }

  if (/made\s+in\s+china|原产国.{0,4}中国|中国制造/i.test(blob)) {
    seed["Country of Origin"] = "中国";
  }
  return seed;
}

function formatProductPageContext(signals: ProductPageSignals): string {
  const lines = [
    "【商品链接网页内容】",
    `URL: ${signals.url}`,
    `站点: ${signals.site}`,
    `抓取方式: ${signals.source}`,
  ];
  if (signals.title) lines.push(`标题: ${signals.title}`);
  if (signals.brand) lines.push(`品牌/厂商: ${signals.brand}`);
  if (signals.model) lines.push(`型号/SKU/ASIN: ${signals.model}`);
  if (signals.asin) lines.push(`ASIN: ${signals.asin}`);
  if (signals.description) lines.push(`描述: ${signals.description}`);
  if (signals.text) {
    lines.push("—— 页面正文摘录 ——");
    lines.push(signals.text.slice(0, 12000));
  }
  if (!signals.title && !signals.text) {
    lines.push("(未能打开网页正文；请仅根据 URL 与站点类型尽量推断，不确定则留空)");
  }
  return lines.join("\n");
}

async function parseOrderRequest(
  voiceText: string,
  link: string,
  files: { filename: string; mime: string; data: Uint8Array }[],
): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  const labels: Record<string, unknown>[] = [];
  if (voiceText) chunks.push(`【语音转写】\n${voiceText}`);

  let pageSignals: ProductPageSignals | null = null;
  if (link) {
    chunks.push(`【商品链接】\n${link}`);
    try {
      pageSignals = await fetchProductPage(link);
      if (pageSignals) chunks.push(formatProductPageContext(pageSignals));
    } catch (err) {
      console.warn("fetchProductPage error", err);
      chunks.push("【商品链接】未能抓取网页，仅提供 URL：" + link);
    }
  }

  for (const item of files) {
    const { text, label } = await extractFile(
      item.filename,
      item.mime,
      item.data,
    );
    if (text.trim()) chunks.push(text);
    if (label) labels.push(label);
  }
  const context = chunks.join("\n\n").trim();
  if (!context) throw new Error("empty_input");

  const seedFromLabels = seedFieldsFromLabels(labels);
  const seedFromLink = seedFromProductPage(pageSignals);
  const seed: FieldMap = { ...seedFromLink };
  for (const key of FIELD_KEYS) {
    // Prefer label OCR over marketplace page when both present
    if (seedFromLabels[key]) seed[key] = seedFromLabels[key];
  }

  try {
    const result = await structureFields(context, seed);
    if (result && typeof result === "object") {
      const summary = (result.product_summary || {}) as Record<string, unknown>;
      if (!summary.hint) {
        summary.hint = pageSignals
          ? `来自商品链接（${pageSignals.site}）`
          : String(summary.hint || "");
      }
      if (pageSignals?.brand && !summary.brand) {
        summary.brand = pageSignals.brand;
      }
      result.product_summary = summary;
      result.source = pageSignals ? "product_link" : result.source;
      (result as Record<string, unknown>).link_meta = pageSignals
        ? {
          url: pageSignals.url,
          site: pageSignals.site,
          fetch: pageSignals.source,
          title: pageSignals.title,
        }
        : undefined;
    }
    return result;
  } catch (err) {
    if (FIELD_KEYS.some((k) => seed[k])) {
      return {
        product_summary: {
          name: seed["Product Name"] || "",
          brand: pageSignals?.brand || "",
          hint: pageSignals
            ? `来自商品链接（${pageSignals.site}）`
            : "来自产品标签识别",
        },
        fields: seed,
        confidence: {},
        raw_excerpt: context.slice(0, 500),
        source: pageSignals ? "product_link" : "seed",
        link_meta: pageSignals
          ? {
            url: pageSignals.url,
            site: pageSignals.site,
            fetch: pageSignals.source,
            title: pageSignals.title,
          }
          : undefined,
      };
    }
    throw err;
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, origin);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse({ error: "invalid_multipart" }, 400, origin);
  }

  const voiceText = String(form.get("voice_text") || "").trim();
  const link = String(form.get("link") || "").trim();
  const files: { filename: string; mime: string; data: Uint8Array }[] = [];

  for (const [name, value] of form.entries()) {
    if (name !== "files" && !String(name).startsWith("files")) continue;
    if (!(value instanceof File)) continue;
    if (files.length >= MAX_FILES) continue;
    if (value.size <= 0) continue;
    if (value.size > MAX_FILE_BYTES) {
      return jsonResponse({ error: "file_too_large" }, 413, origin);
    }
    const buf = new Uint8Array(await value.arrayBuffer());
    files.push({
      filename: value.name || "upload.bin",
      mime: (value.type || "application/octet-stream").toLowerCase(),
      data: buf,
    });
  }

  if (!voiceText && !link && !files.length) {
    return jsonResponse({ error: "empty_input" }, 400, origin);
  }

  try {
    const result = await parseOrderRequest(voiceText, link, files);
    return jsonResponse(result, 200, origin);
  } catch (err) {
    const code = err instanceof Error ? err.message : "upstream_failed";
    console.error("parse-order error", err);
    if (code === "empty_input") {
      return jsonResponse({ error: code }, 400, origin);
    }
    if (code === "missing_nvidia_key") {
      return jsonResponse({ error: code }, 503, origin);
    }
    if (code.startsWith("upstream_http_")) {
      return jsonResponse({ error: code }, 502, origin);
    }
    return jsonResponse({ error: "upstream_failed" }, 502, origin);
  }
});
