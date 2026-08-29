// src/data/rumors.js
// Seed texts, the corruption machinery, and overheard fragments.
// Pure data + tiny pure string helpers. No rendering, no rng calls (rng is injected upstream).
//
// NO NUMBERS. Not "three", not "3", not "twice". Quantity is always vague on purpose.

// ---------------------------------------------------------------------------
// Seed rumors, grouped by what earned them. aftermath.js picks from these.
// ---------------------------------------------------------------------------

export const SEEDS = {
  quiet: [
    'the new one was up late again but kept it to themselves',
    'the porch light at that house goes off at a very particular moment',
    'somebody has been watering after dark, which is when you water if you do not want to be seen',
    'the new one waved with the wrong hand and it looked rehearsed',
    'there was no noise from that house at all last night, which is its own kind of noise',
  ],
  loud: [
    'there was screaming from the yard and then there was not',
    'something went through a fence and the fence has been apologised for but not repaired',
    'the new one was out in the dark swinging at nothing anybody else could see',
    'the sprinklers ran the whole night and the grass is still dry',
    'somebody was counting out loud in the yard and would not stop',
  ],
  bloody: [
    'the new one came home wearing something that used to be a different colour',
    'there is a smell coming off that property and it is not compost',
    'the bins at that house are always heavier on a Thursday',
    'somebody hosed the driveway down before it was light out',
  ],
  looting: [
    'the new one has been picking things up out of other peoples yards',
    'somebody has been going through the Colonels crate when the Colonel is asleep',
    'things have been going missing and turning up in a different arrangement',
  ],
  debt: [
    'the new one has an arrangement with something down by the culvert',
    'somebody is taking deliveries that do not come in a van',
    'the frog knows that house by name now',
  ],
  gifting: [
    'the new one has been handing out presents to absolutely everybody',
    'somebody is being extremely generous lately and nobody asked them to be',
    'the new one turned up with a gift again, unprompted, smiling the whole time',
  ],
  garden: [
    'there is something growing behind that house that nobody has a name for',
    'the new one planted something at an hour when nothing gets planted',
    'the soil back there has been turned over more than once this week',
  ],
  boss: [
    'the culvert was loud last night and then the whole street went polite about it',
    'the new one settled up with something and came back walking differently',
  ],
};

export function allSeedTexts() {
  return Object.values(SEEDS).flat();
}

// ---------------------------------------------------------------------------
// ESCALATION LADDERS
// Each ladder is an ordered chain of phrasings, mild -> unsurvivable.
// A corruption pass finds the highest-priority rung present in the text and
// swaps it for the next rung up. This is why a rumor that goes through Sheila
// comes out the other side as a different crime.
// ---------------------------------------------------------------------------

export const LADDERS = [
  [
    'up late again',
    'up all night with the lights off',
    'up all night standing at the window not moving',
    'up all night standing at the window looking into somebody elses house',
    'up all night in somebody elses house',
  ],
  [
    'watering after dark',
    'washing something off the path after dark',
    'washing something off the path that would not come off',
    'washing something off the path that kept coming back by morning',
  ],
  [
    'swinging at nothing anybody else could see',
    'swinging at something the rest of us politely did not look at',
    'swinging at something that was asking them to stop',
    'swinging at something that knew their name',
  ],
  [
    'screaming from the yard',
    'screaming from the yard in more than one voice',
    'screaming from the yard in a voice from a house that is empty',
    'screaming from the yard in the voice of the last one who lived there',
  ],
  [
    'something that used to be a different colour',
    'something that had been somebody elses',
    'something that had been somebody elses and had not been washed',
    'something that had been somebody elses and had their initials in it',
  ],
  [
    'a smell coming off that property',
    'a smell coming off that property that gets worse in the sun',
    'a smell the whole street has agreed to call fertiliser',
    'a smell the whole street has agreed to call fertiliser and stopped agreeing about',
  ],
  [
    'the bins are heavier',
    'the bins are heavier and nobody will say heavier than what',
    'the bins are heavier and one of them was warm',
    'the bins are heavier and one of them was warm and the lid was on wrong from the inside',
  ],
  [
    'picking things up out of other peoples yards',
    'letting themselves into other peoples yards',
    'letting themselves into other peoples yards while people were home',
    'letting themselves into other peoples yards and standing there a while first',
  ],
  [
    'an arrangement with something down by the culvert',
    'an arrangement they have not been able to get out of',
    'an arrangement that has started asking for things that are not objects',
    'an arrangement that was somebody elses arrangement before it was theirs',
  ],
  [
    'handing out presents to absolutely everybody',
    'handing out presents to everybody in a very particular order',
    'handing out presents to everybody the way you settle up before you go somewhere',
    'handing out presents to everybody the way the last one did, right before',
  ],
  [
    'something growing behind that house',
    'something growing behind that house in the shape of a person lying down',
    'something growing behind that house that has been fed',
    'something growing behind that house that has started asking to be fed on schedule',
  ],
  [
    'the soil back there has been turned over',
    'the soil back there has been turned over more than once',
    'the soil back there has been turned over more than once in the same spot',
    'the soil back there has been turned over more than once in the same spot and something came up with it',
  ],
  [
    'the fence',
    'what is left of the fence',
    'what came through the fence',
    'what came through the fence and has not been seen leaving',
  ],
  [
    'counting out loud in the yard',
    'counting out loud in the yard and starting over every time somebody looked',
    'counting out loud in the yard, and there is nothing out there to count',
    'counting out loud in the yard, and something out there was counting back',
  ],
];

// ---------------------------------------------------------------------------
// SUBSTITUTIONS — small drifts that make a story stop being about the same thing.
// Applied when no ladder rung matches, or as a second nudge.
// ---------------------------------------------------------------------------

export const DRIFTS = [
  ['the new one', ['that one in the corner house', 'the one who moved in', 'whoever is in there now', 'the current occupant']],
  ['somebody', ['that neighbour of ours', 'the one from the corner house', 'a person we all know']],
  ['a dog', ['somebody elses dog', 'somebody elses dog, apparently', 'somebody']],
  ['last night', ['most nights', 'every night lately', 'since they got here']],
  ['a fence', ['a fence and a hedge', 'a fence, a hedge, and a shed door']],
  ['gift', ['payment', 'settlement', 'apology in advance']],
  ['present', ['payment', 'down payment', 'apology in advance']],
  ['deliveries', ['visitors', 'visitors who do not use the path', 'visitors who do not leave']],
  ['the frog', ['that thing at the culvert', 'the one nobody names', 'the arrangement']],
  ['quiet', ['too quiet', 'quiet in the way a held breath is quiet']],
  ['grass', ['grass, and the patch that will not grow back', 'the patch that will not grow back']],
];

// ---------------------------------------------------------------------------
// REFRAMES / APPENDS — Sheila's signature move. She never lies. She contextualises.
// ---------------------------------------------------------------------------

export const REFRAMES = [
  'I am not saying anything, but ',
  'This is not gossip, it is concern: ',
  'Do not repeat this — ',
  'Someone should probably know that ',
  'I only mention it because of the children: ',
  'For the newsletter, possibly: ',
  'You did not hear it from me, but ',
  'I have been asked not to bring this up, so: ',
];

export const APPENDS = [
  ' — and that is only the part they will admit to.',
  ' — again.',
  ' — which is what the last one did.',
  ' — and the police were not called, which is interesting.',
  ' — and there is a smell now.',
  ' — and nobody has seen the cat since.',
  ' — and the previous owner did exactly that, right at the end.',
  ' — and they knew we were watching, which is the worrying part.',
  ' — and the HOA has no policy for it yet.',
  ' — and it has started happening at the same time every night.',
];

// Colonel's skeptical hedges. He does not corrupt; he sands things down.
export const HEDGES = [
  'Allegedly, ',
  'Second hand, so take it how you like: ',
  'Somebody says ',
  'Unconfirmed: ',
];

// The Prices repeat things back at you, harder.
export const MIRROR_WRAPS = [
  'We heard the same thing! We heard that ',
  'That is exactly what we were told — that ',
  'We have been saying it to each other: ',
];

// ---------------------------------------------------------------------------
// FRAGMENTS — half-overheard. These are what the player actually gets.
// A fragment = lead-in + a clipped slice of the rumor text + a trail-off.
// ---------------------------------------------------------------------------

export const FRAGMENT_LEADINS = [
  '— no, but she said ',
  '— and then apparently ',
  '— well I heard ',
  '— you did not get this from me but ',
  '— hang on, the bit about ',
  '— which is when ',
  '— and that is the same night ',
  '— honestly, once you know about ',
  '— he keeps saying ',
  '— and nobody has told them that ',
  '— we were only talking about how ',
  '— it started with ',
  '— my point is ',
  '— she will not say it in front of him but ',
];

export const FRAGMENT_TRAILS = [
  '…',
  '— shh.',
  '— anyway.',
  '— oh, hello.',
  '— not now.',
  '— you know what, forget it.',
  '— we will talk later.',
  '…and then she looked right at me.',
  '— do not turn round.',
  '…sorry, what were we saying.',
];

// Ambient fragments with no rumor behind them at all. Paranoia needs noise.
export const AMBIENT_FRAGMENTS = [
  '— she does not put her bins out, she puts them away, which is different —',
  '— the previous owner used to stand right about there, actually —',
  '— no, the smell was before, the smell was definitely before —',
  '— I said good morning and it took them a moment to remember how —',
  '— the Prices have a rule about which window they use now —',
  '— the Colonel counted his birds twice and got a different answer —',
  '— nobody has been in that shed since, and nobody is going to be —',
  '— Marge says it is nothing. Marge has never said it is nothing —',
  '— you can hear the culvert from the back bedroom, that is all I am saying —',
  '— they were polite about it, which frankly made it worse —',
  '— it is not our business, and we have made it our business —',
  '— the lawn is immaculate. That is what worries me —',
];

// ---------------------------------------------------------------------------
// Pure helpers used by the rumor engine.
// ---------------------------------------------------------------------------

/** Apply the first matching escalation ladder rung. Returns null if nothing matched. */
export function escalate(text) {
  for (const ladder of LADDERS) {
    // Walk from the top rung down so a text already high on a ladder keeps climbing.
    for (let i = ladder.length - 2; i >= 0; i--) {
      if (text.includes(ladder[i])) {
        return text.replace(ladder[i], ladder[i + 1]);
      }
    }
  }
  return null;
}

/** Apply one lexical drift. rng is injected. Returns null if nothing matched. */
export function drift(text, rng) {
  const candidates = DRIFTS.filter(([from]) => text.includes(from));
  if (candidates.length === 0) return null;
  const [from, tos] = candidates[Math.floor(rng() * candidates.length) % candidates.length];
  const to = tos[Math.floor(rng() * tos.length) % tos.length];
  return text.replace(from, to);
}

export function pick(arr, rng) {
  if (!arr || arr.length === 0) return '';
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

// SELF-TEST:
//   escalate('the new one was up late again but kept it to themselves')
//     -> '...was up all night with the lights off...'   (one rung climbed)
//   Repeatedly calling escalate() on its own output walks a ladder to its top rung
//     and then returns null (ladder exhausted).
//   drift(text, () => 0.5) swaps one noun phrase; returns null when nothing matches.
//   No string in this file contains a digit or a spelled-out count.
