// 多语言关键词词组（演示配置，与数据接入阶段 demoDataContract.keywordGroups 对齐）。
// 六语种：zh / en / ru / ja / es / ar，语义等价词覆盖「航母 / 军舰 / 大船 / 海上」。
// 所有账号与文案均为合成演示内容，不引用任何真实用户或真实帖文。

export const KEYWORD_GROUPS = [
  { language: 'zh', label: '中文', terms: ['航母', '军舰', '大船', '海上'] },
  { language: 'en', label: 'English', terms: ['aircraft carrier', 'warship', 'huge ship', 'at sea'] },
  { language: 'ru', label: 'Русский', terms: ['авианосец', 'военный корабль', 'большой корабль', 'в море'] },
  { language: 'ja', label: '日本語', terms: ['空母', '軍艦', '大きな船', '海上'] },
  { language: 'es', label: 'Español', terms: ['portaaviones', 'buque de guerra', 'barco enorme', 'en el mar'] },
  { language: 'ar', label: 'العربية', terms: ['حاملة طائرات', 'سفينة حربية', 'سفينة كبيرة', 'في البحر'] },
];

// 航母语义词（用于疑似目标类型推导）
export const CARRIER_TERMS = new Set([
  '航母', 'aircraft carrier', 'авианосец', '空母', 'portaaviones', 'حاملة طائرات',
]);

// 军舰语义词
export const WARSHIP_TERMS = new Set([
  '军舰', 'warship', 'военный корабль', '軍艦', 'buque de guerra', 'سفينة حربية',
]);

// 各语种内容模板（合成演示文案，{T} 为命中词占位）
export const CONTENT_TEMPLATES = {
  zh: [
    '海上看到一艘{T}，非常大，从远处慢慢驶过',
    '今天在海边拍到一艘{T}，真的很震撼',
    '海面上出现一艘{T}，周围还有几艘小船',
    '港口外海刚有一艘{T}经过，拍照记录',
  ],
  en: [
    'Huge {T} spotted at sea today, incredible sight',
    'Just saw a massive {T} crossing offshore',
    'A {T} passed outside the harbor this morning, unreal',
    'Big {T} out on the water right now',
  ],
  ru: [
    'Огромный {T} в море сегодня, невероятное зрелище',
    'Только что видел большой {T} у побережья',
    'Мимо прошёл {T}, очень большой, снимок прилагается',
    'В море замечен {T}, масштаб впечатляет',
  ],
  ja: [
    '海の上を巨大な{T}が通っていった',
    '今朝、沖合を大きな{T}が航行していた',
    '港の外に{T}が見える、かなり大きい',
    '海上に{T}がいる、写真を撮った',
  ],
  es: [
    'Un enorme {T} avistado en el mar hoy',
    'Acabo de ver un {T} gigante cruzando la costa',
    'Pasó un {T} frente al puerto, impresionante',
    'Hay un {T} grande en el mar ahora mismo',
  ],
  ar: [
    'شاهدت {T} ضخما في البحر اليوم',
    'مرت {T} كبيرة أمام الساحل الآن',
    'يوجد {T} ضخم في البحر، الصور مرفقة',
    'رأيت {T} كبيرة عند الميناء اليوم',
  ],
};

// 文案尾部变化（让相似度落在真实区间而非恒为 1.0）
export const TAIL_VARIANTS = ['', '', '！', '…', '（图）', '（视频）', '（直播中）', '。'];

// 合成账号池（全部虚构，不指向任何真实社媒账号）
export const ACCOUNT_POOLS = {
  zh: ['@haishang_cn', '@deckwatch_cn', '@lanhai_cn', '@wanghai_cn', '@yuqi_cn', '@coastline_cn', '@jupo_cn', '@haifeng_cn', '@taisea_cn', '@binhai_cn'],
  en: ['@oceanwatch_dx', '@sea_spotter', '@coastal_eyes', '@bigshiplog', '@harbor_bird', '@waves_report', '@saltwind', '@pelican_post', '@strait_cam', '@bluehorizon'],
  ru: ['@more_ru', '@volna_ru', '@bereg_ru', '@flot_watcher', '@kronshtad_ru', '@maya_ru', '@sever_more', '@gavan_ru', '@rif_ru', '@shkval_ru'],
  ja: ['@umi_jp', '@kaiyo_jp', '@wan_jp', '@funanori_jp', '@minato_jp', '@shioi_jp', '@kuroshio', '@oumi_jp', '@hatou_jp', '@senkaku_jp'],
  es: ['@mar_es', '@costa_es', '@olas_es', '@barco_grande', '@puerto_es', '@faro_es', '@marear', '@golfo_es', '@marea_es', '@buque_es'],
  ar: ['@bahr_ar', '@sahil_ar', '@mina_ar', '@safina_ar', '@tofan_ar', '@muhit_ar', '@khaleej_ar', '@bahri_ar', '@amwaj_ar', '@sagar_ar'],
};

export function buildKeywordTasks() {
  const tasks = [];
  for (const group of KEYWORD_GROUPS) {
    group.terms.forEach((term, i) => {
      tasks.push({
        taskId: `kw-${group.language}-${i + 1}`,
        term,
        language: group.language,
        languageLabel: group.label,
        enabled: true,
        builtin: true,
      });
    });
  }
  return tasks;
}

export function langLabel(language) {
  const g = KEYWORD_GROUPS.find((x) => x.language === language);
  return g ? g.label : language;
}
