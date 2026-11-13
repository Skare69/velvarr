import assert from "node:assert/strict";
import { test } from "node:test";
import {
  partialDate,
  tpdbPerformerPerson,
} from "../src/server/provider-rows.ts";

// Person facts are mapped only as published: partial dates keep their
// accuracy, units are parsed only when named, ambiguous flags are dropped.

test("partial dates keep the accuracy of the parts that exist", () => {
  assert.deepEqual(partialDate("2020-05-03"), {
    date: "2020-05-03",
    accuracy: "day",
  });
  assert.deepEqual(partialDate("2020-05"), {
    date: "2020-05-01",
    accuracy: "month",
  });
  assert.deepEqual(partialDate("2020"), {
    date: "2020-01-01",
    accuracy: "year",
  });
  assert.equal(partialDate("2020-02-30"), undefined);
  assert.equal(partialDate("May 2020"), undefined);
  assert.equal(partialDate(null), undefined);
});

test("TPDB extras map with units parsed and ambiguous flags dropped", () => {
  // Xander Corvus's real extras block (TPDB, read 2026-11-13), trimmed.
  const person = tpdbPerformerPerson({
    gender: "Male",
    birthday: "1988-11-18",
    deathday: null,
    birthplace: "Columbus, OH, USA",
    astrology: "Scorpio",
    ethnicity: "Caucasian",
    nationality: "American",
    hair_colour: "Brunette",
    eye_colour: "Hazel",
    weight: "72kg",
    height: "180cm",
    measurements: null,
    cupsize: null,
    tattoos: "None",
    piercings: "Lower lip",
    waist: null,
    hips: null,
    fake_boobs: false,
    same_sex_only: false,
    career_start_year: 2010,
    career_end_year: null,
  });
  assert.deepEqual(person, {
    gender: "Male",
    birthDate: "1988-11-18",
    birthDateAccuracy: "day",
    birthplace: "Columbus, OH, USA",
    nationality: "American",
    ethnicity: "Caucasian",
    eyeColor: "Hazel",
    hairColor: "Brunette",
    heightCm: 180,
    weightKg: 72,
    careerStartYear: 2010,
    tattoos: ["None"],
    piercings: ["Lower lip"],
  });
});

test("a value in an unnamed or other unit is dropped, never misread", () => {
  const p = tpdbPerformerPerson({ weight: "160lbs", height: "5'11\"" });
  assert.equal(p, undefined);
});
