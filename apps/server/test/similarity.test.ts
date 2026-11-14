import { expect, test } from "vitest"
import { defaultThresholds, normalizeMaterialName, similarityIndex } from "../src/modules/catalogue/similarity.js"

const pairs = [
  ["حَمْض السِّتريك", "حمض الستريك"],
  ["حمض الستريك", "حامض ستريك"],
  ["كربونات الكالسيوم", "كاربونات الكالسيوم"],
  ["كلوريد الصوديوم", "صوديوم كلوريد"],
  ["أسمنت أبيض", "اسمنت الابيض"],
  ["زبدة نباتية", "زبدة نَبَاتيّة"],
  ["مسـحوق الكاكاو", "مسحوق الكاكاو"],
  ["بودرة الحليب", "بودره الحليب"],
  ["زيت دوار الشمس", "زيت دوّار الشّمس"],
  ["مسحوق رقم ١٢", "مسحوق رقم 12"],
  ["مادة ۴۵", "مادة 45"],
  ["ABS Powder", "abs powder"],
  ["رمل-سيليكا", "رمل سيليكا"],
  ["طحين قمح كامل", "كامل قمح طحين"],
  ["زيت زيتون بكر", "زيت الزيتون البكر"],
  ["ملح الطعام الناعم", "ملح طعام ناعم"],
  ["صمغ عربي خام", "صمغ عربي ناعم"],
  ["مسحوق حليب كامل الدسم", "مسحوق حليب قليل الدسم"],
  ["عَلَف   الذُّرة", "علف الذره"],
  ["المستخلص النباتي", "مستخلص نباتي"],
] as const

test.each(pairs)("detects %s and %s", (existing, input) => {
  const index = similarityIndex([{
    id: "fixture", name: existing, code: "MAT-FIXTURE", nameNormalized: normalizeMaterialName(existing),
    unitId: "kg", archived: false,
  }], defaultThresholds)
  expect(index.check(normalizeMaterialName(input), "kg").level).not.toBe("clear")
  expect(index.check(normalizeMaterialName("ورق تغليف"), "kg").level).toBe("clear")
})
