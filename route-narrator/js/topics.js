// Topics a listener can pick, and a classifier that tags a Wikipedia article
// with topics from its title, short description and categories.

export const TOPICS = [
  { id: 'history', label: 'History', icon: '🏛️', color: '#b45309',
    re: /\bhistor|\bfounded\b|\bsettle(d|ment)|colonial|\bcentury\b|national register|landmark|heritage|\bfort\b|\bmonument|memorial|archaeolog|ruins|\bera\b|prehistor|\bmill\b|\bpioneer/i },
  { id: 'military', label: 'Wars & Battles', icon: '⚔️', color: '#991b1b',
    re: /\bbattle|\bwar\b|wars\b|civil war|revolutionary war|military|\bfort\b|battlefield|siege|\barmy\b|\bnaval|veterans/i },
  { id: 'towns', label: 'Towns & Cities', icon: '🏘️', color: '#4b5563',
    re: /^(city|town|village|borough|hamlet|census-designated place|unincorporated community|county seat|neighbo(u)?rhood|municipality|commune|suburb)\b|\b(city|town|village|borough|hamlet|census-designated place|unincorporated community|municipality|commune|suburb) (in|of)\b|^(cities|towns|villages|boroughs|hamlets|census-designated places|unincorporated communities|neighbo(u)?rhoods|county seats|populated places|municipalities|communes|suburbs) (in|of)\b/i },
  { id: 'architecture', label: 'Architecture', icon: '🏰', color: '#7c3aed',
    re: /architect|\bbuilding|\bhouses?\b|mansion|\bchurch|cathedral|chapel|\btemple|synagogue|mosque|courthouse|\bcastle|lighthouse|\btower|skyscraper|\bhall\b|victorian|gothic|georgian|art deco|\bstyle\b|covered bridge|\bmanor/i },
  { id: 'nature', label: 'Nature & Parks', icon: '🌲', color: '#15803d',
    re: /\bpark\b|parks\b|forest|wilderness|\briver|\blakes?\b|reservoir|waterfall|\bfalls\b|mountain|\bpeak|\bhills?\b|valley|canyon|gorge|\bcreek|\bbay\b|beach|island|wildlife|nature|protected area|state park|national park|trail|\bgarden|preserve|wetland|marsh|\bglacier/i },
  { id: 'geology', label: 'Geology & Landforms', icon: '🪨', color: '#78716c',
    re: /geolog|volcan|\bcrater|landform|rock formation|\bcave|caverns?|\bfossil|glacial|\bmesa|\bbutte|\bcliff|\bescarpment|\bmountain|summits?\b|\bpass\b|\bspring\b|hot springs/i },
  { id: 'transport', label: 'Roads, Rails & Bridges', icon: '🚂', color: '#0369a1',
    re: /railway|railroad|\brail\b|station|\bbridge|\btunnel|\bcanal|highway|\broute\b|turnpike|interstate|\bairport|aviation|\bharbo(u)?r|\bport\b|\bferry|trolley|streetcar|\bdepot/i },
  { id: 'industry', label: 'Industry & Science', icon: '⚙️', color: '#a16207',
    re: /industr|\bfactory|\bmills?\b|\bmine\b|mining|\bmines\b|quarry|power station|power plant|\bdam\b|observatory|laborator|research|nuclear|manufactur|company|companies|\bforge|brewery|distillery|winery|vineyard/i },
  { id: 'people', label: 'Notable People', icon: '👤', color: '#be185d',
    re: /\bpeople (from|of)\b|\bbirthplace|\bbirth(s)?\b|\bhome of\b|\bhomestead|\bgrave|\bcemeter|\bburials?\b|\bpresident|\bbiograph|\bauthor|\bwriter|\bpoet\b|\binventor/i },
  { id: 'arts', label: 'Arts, Music & Film', icon: '🎭', color: '#c2410c',
    re: /\bmuseum|\bgallery|\bart\b|\barts\b|\btheat(er|re)|\bmusic|\bconcert|\bopera|\bfilm|\bmovie|filming location|\bliterature|\bnovel|\bsculpture|\bmural|festival/i },
  { id: 'sports', label: 'Sports', icon: '🏟️', color: '#047857',
    re: /\bstadium|\barena\b|\bsports?\b|\bbaseball|\bfootball|\bsoccer|\bbasketball|\bhockey|\bgolf|\bspeedway|\braceway|\bracecourse|\bski\b|ski area|\bolympic/i },
  { id: 'native', label: 'Indigenous Heritage', icon: '🪶', color: '#9a3412',
    re: /native american|first nations|indigenous|\btribe|\btribal|reservation|\bpueblo|\bmound|aboriginal|\bmāori|\bmaori|\bpre-columbian|\binuit/i },
  { id: 'quirky', label: 'Odd & Quirky', icon: '🛸', color: '#6d28d9',
    re: /roadside attraction|ghost town|haunted|\bghost|\bufo\b|\bmyster|\blegend|folklore|\bcurios|\bnovelty|\blargest\b|world's (largest|biggest)|abandoned|\bodd\b|\bunusual/i },
];

export const TOPIC_BY_ID = Object.fromEntries(TOPICS.map((t) => [t.id, t]));

// Categories that describe Wikipedia housekeeping rather than the subject.
const NOISE = /articles|pages|wikidata|coordinates|stub|webarchive|cs1|use (mdy|dmy)|short description|commons category|all (articles|stub)|infobox|wikipedia|template|lacking|needing|with (unsourced|dead)/i;

/**
 * Tag an article with topic ids.
 * @param {{title:string, description?:string, categories?:string[]}} page
 * @returns {string[]} topic ids, most relevant first
 */
export function classify(page) {
  const cats = (page.categories || [])
    .map((c) => c.replace(/^Category:/, ''))
    .filter((c) => !NOISE.test(c));
  const desc = page.description || '';
  const scores = {};
  for (const t of TOPICS) {
    let s = 0;
    if (t.re.test(desc)) s += 3;
    if (t.re.test(page.title || '')) s += 2;
    for (const c of cats) if (t.re.test(c)) s += 1;
    if (s > 0) scores[t.id] = s;
  }
  // A town is a town: don't also call it "nature" because it's on a river.
  if (scores.towns >= 3) {
    for (const k of Object.keys(scores)) if (k !== 'towns' && k !== 'history' && scores[k] < 3) delete scores[k];
    scores.history = (scores.history || 0) + 1; // every town has a story
  }
  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}

/**
 * How interesting an article is likely to be to this listener.
 * Long articles (more written about them) and topic matches score higher.
 */
export function scorePoi(poi, selected, mode) {
  const lengthScore = Math.log10(Math.max(500, poi.length || 500)); // ~2.7 .. 5
  const matches = poi.topics.filter((t) => selected.has(t)).length;
  if (mode === 'only' && selected.size && !matches) return 0;
  let s = lengthScore;
  if (selected.size) s *= matches ? 1.6 + 0.2 * Math.min(2, matches - 1) : 0.6;
  // General-interest mode leans toward history even without picks.
  if (!selected.size && poi.topics.includes('history')) s *= 1.25;
  return s;
}
