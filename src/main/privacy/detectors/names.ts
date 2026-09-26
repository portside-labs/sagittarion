// Person names without a model: titles ("Dr. Richardson"), relations ("my son Jonathan"), introductions ("named
// Sarah", "Hi Sarah"), and a list of common given names and surnames. Prose only; schema text is left alone so a
// table or column that happens to look like a name keeps working in SQL.
import type { DetectionContext, SensitiveDataDetector, SensitiveDetection, TextRole } from '../types'
import type { SensitiveEntityType } from '@shared/privacy'
import { AMBIGUOUS_NAMES, GIVEN_NAMES, SURNAMES, nameKey } from './name-data'

/** One capitalised name word: Jack, O'Brien, McDonald, Jean-Luc, José. Never part of a longer word. */
const WORD =
  "(?:\\p{Lu}['’]\\p{Lu}[\\p{Ll}\\p{M}]+|\\p{Lu}[\\p{Ll}\\p{M}]+(?:\\p{Lu}[\\p{Ll}\\p{M}]+)?)(?:['’](?:\\p{Lu}[\\p{Ll}\\p{M}]+|[\\p{Ll}\\p{M}]{2,})|-\\p{Lu}[\\p{Ll}\\p{M}]+)*(?![\\p{L}\\p{M}\\p{N}])"
const INITIAL = '\\p{Lu}\\.(?=\\s+\\p{Lu})'
const NAME = `(?:${WORD})(?:[ \\t]+(?:${WORD}|${INITIAL})){0,2}`

function either(list: string[]): string {
  return list.map((w) => `[${w[0].toUpperCase()}${w[0].toLowerCase()}]${w.slice(1)}`).join('|')
}

const TITLES = [
  'Dr', 'Mr', 'Mrs', 'Ms', 'Miss', 'Mx', 'Prof', 'Professor', 'Sir', 'Dame', 'Lady', 'Lord', 'Rev', 'Reverend', 'Fr', 'Father', 'Hon',
  'Judge', 'Justice', 'Capt', 'Captain', 'Sgt', 'Sergeant', 'Lt', 'Lieutenant', 'Col', 'Colonel', 'Officer', 'Detective', 'Nurse',
  'Coach', 'Senator', 'Sen', 'Rep', 'Governor', 'Gov', 'Mayor', 'Madam', 'Madame', 'Mme', 'Mlle', 'Mister', 'Herr', 'Frau', 'Señor',
  'Señora', 'Señorita', 'Sra', 'Srta', 'Doña', 'Dona'
]

const RELATIONS = [
  'son', 'daughter', 'wife', 'husband', 'mother', 'father', 'mom', 'mum', 'mommy', 'dad', 'daddy', 'brother', 'sister', 'grandson',
  'granddaughter', 'grandmother', 'grandma', 'granny', 'grandfather', 'grandpa', 'aunt', 'auntie', 'uncle', 'cousin', 'nephew', 'niece',
  'partner', 'fiancé', 'fiancée', 'fiance', 'fiancee', 'boyfriend', 'girlfriend', 'spouse', 'child', 'kid', 'stepson', 'stepdaughter',
  'stepmother', 'stepfather', 'stepbrother', 'stepsister', 'sibling', 'twin', 'caregiver', 'guardian', 'son-in-law', 'daughter-in-law',
  'mother-in-law', 'father-in-law', 'brother-in-law', 'sister-in-law'
]

/** Introductions after which any capitalised words are a name. */
const STRONG_INTRO = `${either(['named', 'called'])}|[Nn]ame\\s+(?:is|was)|[Nn]ames\\s+(?:are|were)|[Nn]ame\\s*:|[Cc]all\\s+me|[Ss]igned(?:\\s+by)?|[Aa]ttn:?|(?:${either(['contact', 'patient', 'client', 'customer', 'author', 'owner', 'assignee', 'reporter', 'from', 'to', 'cc'])}):`
/** Greetings and self-introductions: a name only when it looks like one (on the list, or two capitalised words). */
const WEAK_INTRO = `I'm|I\\s+am|${either(['dear', 'hi', 'hello', 'hey', 'regards,', 'thanks,', 'cheers,', 'sincerely,', 'best,'])}`

/** Capitalised words that follow those phrases without being names. */
const STOP = new Set(
  `the a an and or but if then else when where what who which why how all any each every some no not yes this that these those
  it its i we you he she they me us him her them my our your his their in on at to for of with by from as is are was were be
  been has have had do does did can could should would will shall may might must show list find get give count select called
  said told asked emailed texted wrote sent paid ordered bought signed joined left moved lives works team everyone everybody
  customer customers client clients user users admin support sales marketing there folks guys world manager sir madam friend
  friends order orders account accounts street avenue road inc llc ltd corp company group department hospital school
  university college bank center centre clinic store shop table column database query report please thanks thank hello hi dear
  regards monday tuesday wednesday thursday friday saturday sunday january february march april june july august september
  october november december today tomorrow yesterday morning evening night sql api ai mr mrs dr ms`
    .split(/\s+/)
    .filter(Boolean)
)

/** Particles inside family names: Guido van Rossum, Ursula von der Leyen, Gabriel García de la Cruz. */
const PARTICLE = '(?:van|von|de|da|di|del|della|der|den|le|la|du|dos|das|bin|ibn|al|el|ter|ten|zu|y)'

/** Capitalised words that make "Chase Bank" or "May Day" a thing or a place rather than a person. */
const PLACE_OR_ORG = new Set(
  `day days week weeks month months year years quarter sale sales plan plans order orders report reports account accounts bank banks
  river lake lakes sea ocean bay beach coast harbor harbour port point springs creek falls valley hill hills mountain mountains
  island islands park parks garden gardens forest woods field fields farm farms ranch estate estates street avenue road lane drive
  way boulevard court place square plaza heights village town city county state province region district kingdom republic
  station airport airlines mall market store shop cafe restaurant bar club church cathedral museum library stadium arena
  theater theatre tower bridge house hall manor building office department ministry bureau agency institute foundation
  association society council committee board team fund trust holdings partners capital ventures labs systems solutions
  services technologies tech motors foods pharmaceuticals media news times post journal review magazine records studios
  pictures entertainment network channel radio online digital software cloud data analytics brand bowl cup series
  school schools university college academy hospital clinic center centre company group inc llc ltd corp corporation
  texas california florida york jersey carolina dakota virginia georgia washington oregon nevada arizona utah colorado ohio
  michigan illinois indiana kentucky tennessee alabama louisiana mississippi arkansas missouri kansas nebraska iowa
  minnesota wisconsin montana idaho wyoming alaska hawaii maine vermont massachusetts connecticut pennsylvania maryland
  delaware usa us uk america canada mexico france germany italy spain portugal china japan india brazil australia ireland
  england scotland wales europe asia africa manhattan brooklyn`
    .split(/\s+/)
    .filter(Boolean)
)

/** Nouns that make "named X" or "called X" about a thing rather than a person. */
const THING_BEFORE =
  /(?:table|column|view|schema|index|field|database|db|function|trigger|file|tab|query|report|sheet|folder|project|product|category|tag|status|type|plan|group|role|team|company|store|city|town|country|state|street|place|brand|app|application|service|program|course|class|event|campaign|model|feature|package|module|library|repo|repository|branch|variable|parameter|setting|option|key|enum|value|label|list|page|section|document|doc|template|workflow|job|task|queue|topic|channel|server|host|cluster|bucket|region|zone|warehouse|org|organization|account|workspace|board|sprint|release|version|flag|thing|item|something|anything|one)s?\s*$/i

const TITLE_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${TITLES.join('|')})\\.?[ \\t]+(?<v>${NAME})`, 'dgu')
const RELATION_RE = new RegExp(`(?<![\\p{L}])(?:${either(RELATIONS)})[ \\t]*,?[ \\t]+(?:(?:named|called)[ \\t]+)?(?<v>${NAME})`, 'dgu')
const STRONG_RE = new RegExp(`(?<![\\p{L}])(?<intro>${STRONG_INTRO})[ \\t]+(?<v>${NAME})`, 'dgu')
const WEAK_RE = new RegExp(`(?<![\\p{L}])(?:${WEAK_INTRO})[ \\t]+(?<v>${NAME})`, 'dgu')
const LOWER_INTRO_RE = /(?<![\p{L}])(?:named|called|name\s+is|name\s+was)[ \t]+(?<v>[\p{Ll}][\p{Ll}\p{M}'’-]+(?:[ \t]+[\p{Ll}][\p{Ll}\p{M}'’-]+)?)/dgu
const SCRIPT_INTRO_RE =
  /(?:named|called|name\s+is|叫|名叫|名字是|이름은)\s*(?<v>[\p{Script=Han}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Katakana}\p{Script=Hiragana}]{2,12})/dgu
const CAPITALISED_RE = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}'’-])${WORD}`, 'gu')
const UPPER_RE = /(?<![\p{L}\p{N}'’])\p{Lu}{3,}(?![\p{L}\p{N}])/gu
const LOWER_PAIR_RE = /(?<![\p{L}])(?<a>[\p{Ll}]{2,})(?=[ \t]+(?<b>[\p{Ll}]{2,})(?![\p{L}]))/gu

const RIGHT_NAME = new RegExp(`^[ \\t]+(?:${PARTICLE}[ \\t]+)?(?:(${WORD})|${INITIAL})`, 'u')
const LEFT_NAME = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}'’-])(${WORD})[ \\t]+(?:${PARTICLE}[ \\t]+)?$`, 'u')
const FOLLOWING_NAME = new RegExp(`^[ \\t]+(${WORD})`, 'u')

const known = (w: string) => {
  const k = nameKey(w)
  return (GIVEN_NAMES.has(k) || SURNAMES.has(k)) && !AMBIGUOUS_NAMES.has(k)
}
const isGiven = (w: string) => GIVEN_NAMES.has(nameKey(w)) && !AMBIGUOUS_NAMES.has(nameKey(w))
const isSurname = (w: string) => SURNAMES.has(nameKey(w)) && !AMBIGUOUS_NAMES.has(nameKey(w))

/** Drops trailing words that are not names ("Sarah Called" -> "Sarah"); null when nothing is left. */
function nameSpan(text: string, start: number, end: number): [number, number] | null {
  const words = [...text.slice(start, end).matchAll(/\S+/g)]
  let keep = words.length
  while (keep > 0 && STOP.has(nameKey(words[keep - 1][0].replace(/\.$/, '')))) keep--
  if (keep === 0) return null
  if (STOP.has(nameKey(words[0][0]))) return null
  const last = words[keep - 1]
  return [start, start + (last.index ?? 0) + last[0].length]
}

export class NameDetector implements SensitiveDataDetector {
  readonly id = 'names'
  readonly version = 1
  readonly roles: readonly TextRole[] = ['prose']

  detect(text: string, _ctx: DetectionContext): SensitiveDetection[] {
    const out: SensitiveDetection[] = []
    const push = (start: number, end: number, rule: string, confidence: number, type: SensitiveEntityType = 'PERSON_NAME') => {
      if (end > start) out.push({ start, end, value: text.slice(start, end), type, confidence, source: 'deterministic', detector: `names.${rule}` })
    }
    const fromGroup = (m: RegExpMatchArray, rule: string, confidence: number, type?: SensitiveEntityType, accept?: (value: string) => boolean) => {
      const g = m.indices?.groups?.v
      if (!g) return
      const span = nameSpan(text, g[0], g[1])
      if (!span) return
      const value = text.slice(span[0], span[1])
      if (accept && !accept(value)) return
      push(span[0], span[1], rule, confidence, type)
    }

    for (const m of text.matchAll(TITLE_RE)) fromGroup(m, 'title', 0.9)
    for (const m of text.matchAll(RELATION_RE)) fromGroup(m, 'relation', 0.85, 'RELATIVE_NAME')
    for (const m of text.matchAll(STRONG_RE)) {
      const intro = m.groups?.intro ?? ''
      if (/^(named|called)$/i.test(intro) && THING_BEFORE.test(text.slice(Math.max(0, (m.index ?? 0) - 32), m.index))) continue
      fromGroup(m, 'introduced', 0.85)
    }
    for (const m of text.matchAll(WEAK_RE)) fromGroup(m, 'greeting', 0.75, 'PERSON_NAME', (v) => known(v.split(/\s+/)[0]) || /\s/.test(v))
    for (const m of text.matchAll(LOWER_INTRO_RE)) {
      if (THING_BEFORE.test(text.slice(Math.max(0, (m.index ?? 0) - 32), m.index))) continue
      const g = m.indices?.groups?.v
      if (!g) continue
      const [first, second] = text.slice(g[0], g[1]).split(/[ \t]+/)
      if (!known(first)) continue
      push(g[0], second && known(second) ? g[1] : g[0] + first.length, 'introduced-lowercase', 0.75)
    }
    for (const m of text.matchAll(SCRIPT_INTRO_RE)) {
      const g = m.indices?.groups?.v
      if (g) push(g[0], g[1], 'introduced-script', 0.7)
    }

    /** Up to two more name words, with particles: "Jack Smith", "Guido van Rossum", "John F. Kennedy". */
    const extendRight = (end: number): number => {
      for (let i = 0; i < 2; i++) {
        const next = RIGHT_NAME.exec(text.slice(end))
        if (!next) break
        const w = next[1] ?? next[0].trim()
        if (next[1] && (STOP.has(nameKey(w)) || PLACE_OR_ORG.has(nameKey(w)))) break
        end += next[0].length
      }
      return end
    }

    // The gazetteer: a known given name, plus the capitalised words that follow it; or a known surname alone.
    let skipUntil = -1
    for (const m of text.matchAll(CAPITALISED_RE)) {
      const start = m.index ?? 0
      if (start < skipUntil) continue
      const word = m[0]
      if (isGiven(word)) {
        const end = extendRight(start + word.length)
        push(start, end, 'given-name', 0.75)
        skipUntil = end
      } else if (isSurname(word)) {
        // A capitalised word before a known surname is its first name: "Tim Thompson", "Ada van Wirth".
        const before = LEFT_NAME.exec(text.slice(Math.max(0, start - 64), start))
        const left = before && !STOP.has(nameKey(before[1])) && !PLACE_OR_ORG.has(nameKey(before[1])) ? start - before[0].length : start
        const end = extendRight(start + word.length)
        push(left, end, 'surname', left < start ? 0.7 : 0.6)
        skipUntil = end
      } else if (AMBIGUOUS_NAMES.has(nameKey(word))) {
        // A word that is also a name counts when a capitalised word that is not a place or a company follows:
        // "Grace Hopper", "Will Smith"; not "Chase Bank", "May Day" or "Austin Texas".
        const next = FOLLOWING_NAME.exec(text.slice(start + word.length))
        const w = next?.[1]
        if (!w || STOP.has(nameKey(w)) || PLACE_OR_ORG.has(nameKey(w)) || AMBIGUOUS_NAMES.has(nameKey(w))) continue
        const end = extendRight(start + word.length)
        push(start, end, 'ambiguous-given-name', 0.55)
        skipUntil = end
      }
    }

    // Shouted names: JACK, JACK SMITH.
    for (const m of text.matchAll(UPPER_RE)) {
      const start = m.index ?? 0
      if (!isGiven(m[0])) continue
      let end = start + m[0].length
      const next = /^[ \t]+(\p{Lu}{2,})(?![\p{L}\p{N}])/u.exec(text.slice(end))
      if (next && known(next[1])) end += next[0].length
      push(start, end, 'given-name-upper', 0.6)
    }

    // Lower-case first and last names together: "orders for jack smith".
    for (const m of text.matchAll(LOWER_PAIR_RE)) {
      const a = m.groups?.a ?? ''
      const b = m.groups?.b ?? ''
      if (!isGiven(a) || !isSurname(b)) continue
      const start = m.index ?? 0
      const end = text.indexOf(b, start + a.length) + b.length
      push(start, end, 'full-name-lowercase', 0.65)
    }
    return out
  }
}
