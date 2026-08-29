// src/data/neighbors.js
// The seven. Fixed ids per docs/CONTRACT.md. Data only — no logic, no rendering.
//
// Every neighbor has:
//   relay      — how they pass rumors on (see src/systems/rumor.js)
//   likes/hates — gift preference profile, matched against Item {kind, rarity, neighborId}
//   voice      — lines they say. Never numeric. Always a little wrong.

export const RELAY = {
  HUB: 'hub',           // corrupts everything that passes through
  SKEPTIC: 'skeptic',   // slows spread, sometimes refuses
  ORIGIN: 'origin',     // speaks, never relays
  FAST: 'fast',         // forwards immediately, forwards everything
  MIRROR: 'mirror',     // echoes back to whoever told them
  TERMINAL: 'terminal', // absorbs. nothing leaves.
};

export const NEIGHBOR_DEFS = [
  {
    id: 'sheila',
    name: 'Sheila Vance',
    title: 'HOA Corresponding Secretary',
    waveIdentity: 'Lawn Gnome Swarm',
    vendorId: 'sheila',
    relay: RELAY.HUB,
    // Sheila likes anything that looks like compliance.
    likes: { kinds: ['produce', 'relic'], rarityFloor: 1, tags: ['tidy', 'floral', 'documented'] },
    hates: { kinds: ['junk'], tags: ['dug-up', 'wet', 'unlabelled'] },
    // How hard gifts move her. Hub neighbors are cheap to please and expensive to keep pleased.
    giftSensitivity: 1.15,
    suspicionSensitivity: 1.6,
    voice: {
      greet: [
        'Oh, you. I was just saying your name. Nothing bad. Mostly nothing bad.',
        'You look tired. I mean that in the caring way. The caring way is how I meant it.',
        'The bins were out early again. I noticed. I notice as a hobby.',
      ],
      giftGood: [
        'Well. That is thoughtful. I will mention that you were thoughtful. I mention things.',
        'This will look lovely on the sideboard where guests can see it and ask about you.',
      ],
      giftBad: [
        'You brought me that. On purpose. With your hands. All right.',
        'I will find somewhere for it. Somewhere sealed. Thank you so much.',
      ],
      giftSuspicious: [
        'Another one. You are so generous lately. Lately being the operative word.',
        'People who bring gifts every single day are either very kind or very busy elsewhere.',
      ],
      shop: [
        'Everything is priced fairly, which is to say priced according to how you have been behaving.',
        'I do not take money. I take an interest.',
      ],
    },
  },

  {
    id: 'colonel',
    name: 'The Colonel',
    title: 'retired, allegedly',
    waveIdentity: 'Chicken flock',
    vendorId: 'colonel',
    relay: RELAY.SKEPTIC,
    likes: { kinds: ['relic', 'weapon'], rarityFloor: 2, tags: ['old', 'metal', 'buried'] },
    hates: { kinds: ['produce'], tags: ['floral', 'store-bought'] },
    giftSensitivity: 0.7,
    suspicionSensitivity: 0.5,
    voice: {
      greet: [
        'Heard a story about you. Did not believe the middle of it.',
        'Birds were quiet last night. Birds are never quiet. Draw your own conclusion.',
        'I do not repeat things. I hold them until they get heavier.',
      ],
      giftGood: [
        'Now that has been in the ground. I can smell the ground on it. Good.',
        'Somebody kept this a long time before they lost it. Fine. Fine.',
      ],
      giftBad: [
        'It is a vegetable. I have seen vegetables.',
        'Take it back before the birds decide it is theirs.',
      ],
      giftSuspicious: [
        'Third time this week a man has tried to buy me with objects. Second time it was you.',
        'Generosity is a tactic. I am not saying it is your tactic. I am saying it is a tactic.',
      ],
      shop: [
        'No money at the crate. Money leaves a record. Bring me something with history on it.',
        'Trade or do not. The crate does not care and neither, officially, do I.',
      ],
    },
  },

  {
    id: 'frog',
    name: 'Debt Frog',
    title: 'unincorporated',
    waveIdentity: 'Boss',
    vendorId: 'frog',
    relay: RELAY.ORIGIN,
    // The Frog does not want gifts. It wants the arrangement to continue.
    likes: { kinds: [], rarityFloor: 9, tags: [] },
    hates: { kinds: ['produce', 'junk', 'seed'], tags: [] },
    giftSensitivity: 0.2,
    suspicionSensitivity: 0.0,
    voice: {
      greet: [
        'You came back. Of course. The arrangement is comfortable.',
        'No paperwork. Paperwork upsets people.',
        'I never say your name out loud. Out loud is where the trouble is.',
      ],
      giftGood: ['Keep it. You will want something to hold later.'],
      giftBad: ['I do not take gifts. Gifts end. We are not ending.'],
      giftSuspicious: ['You are trying to make this a friendship. It is better than a friendship.'],
      shop: [
        'Take what you like. We will settle it the way we always settle it.',
        'No, no. No total. Totals ruin the evening.',
      ],
    },
  },

  {
    id: 'marge',
    name: 'Marge Tillery',
    title: 'block watch, self-appointed',
    waveIdentity: 'Sprinkler Wraith',
    vendorId: null,
    relay: RELAY.FAST,
    likes: { kinds: ['produce', 'seed'], rarityFloor: 0, tags: ['floral', 'homemade'] },
    hates: { kinds: ['weapon'], tags: ['metal', 'wet'] },
    giftSensitivity: 1.0,
    suspicionSensitivity: 1.3,
    voice: {
      greet: [
        'Do not tell anyone I told you, and I am going to tell you immediately.',
        'I only repeat what I hear. I hear constantly. It is a burden.',
        'Dwayne says the same thing I say but slower, so I say it first.',
      ],
      giftGood: ['Oh, homemade. I will tell everyone it was homemade. Everyone.'],
      giftBad: ['That is a tool. Why would you hand a woman a tool.'],
      giftSuspicious: ['You keep giving me things and I keep wondering out loud about it.'],
      shop: [],
    },
  },

  {
    id: 'dwayne',
    name: 'Dwayne Boggs',
    title: 'has a truck',
    waveIdentity: 'Sprinkler Wraith',
    vendorId: null,
    relay: RELAY.FAST,
    likes: { kinds: ['junk', 'weapon'], rarityFloor: 0, tags: ['metal', 'loud'] },
    hates: { kinds: ['relic'], tags: ['buried', 'floral'] },
    giftSensitivity: 0.9,
    suspicionSensitivity: 1.1,
    voice: {
      greet: [
        'Marge already told me. I am acting surprised for her sake.',
        'I saw nothing, and I have described it to four people.',
        'Not my business. Told everybody it is not my business.',
      ],
      giftGood: ['Hey. Heavy. I like when they are heavy.'],
      giftBad: ['What am I supposed to do, plant it? Bury it? Do not answer that.'],
      giftSuspicious: ['You are being real friendly this week. Real friendly.'],
      shop: [],
    },
  },

  {
    id: 'newlyweds',
    name: 'The Prices',
    title: 'so happy to be here',
    waveIdentity: 'Newlywed Elite',
    vendorId: null,
    relay: RELAY.MIRROR,
    likes: { kinds: ['produce', 'relic'], rarityFloor: 1, tags: ['floral', 'matching', 'store-bought'] },
    hates: { kinds: ['junk'], tags: ['dug-up', 'old'] },
    giftSensitivity: 1.3,
    suspicionSensitivity: 1.4,
    voice: {
      greet: [
        'We heard! Well — we heard something. We heard it together, which makes it true.',
        'We were told the street is very safe. We repeat that to each other most nights.',
        'We do not gossip. We debrief.',
      ],
      giftGood: ['It matches! Everything is going to match, we have decided.'],
      giftBad: ['We will put it in the room we do not go in.'],
      giftSuspicious: ['You are our favourite. Everyone should know you are our favourite. We will tell them.'],
      shop: [],
    },
  },

  {
    id: 'previous',
    name: 'The Previous Owner',
    title: 'no forwarding address',
    waveIdentity: 'absent / haunting',
    vendorId: null,
    relay: RELAY.TERMINAL,
    likes: { kinds: [], rarityFloor: 9, tags: [] },
    hates: { kinds: [], tags: [] },
    giftSensitivity: 0.0,
    suspicionSensitivity: 0.0,
    voice: {
      greet: [
        'The mail still comes. Some of it is addressed to a habit rather than a person.',
        'Somebody stood exactly where you are standing and thought exactly this.',
        '',
      ],
      giftGood: [''],
      giftBad: [''],
      giftSuspicious: [''],
      shop: [],
    },
  },
];

export function neighborDef(id) {
  return NEIGHBOR_DEFS.find((n) => n.id === id) || null;
}

export const NEIGHBOR_IDS = NEIGHBOR_DEFS.map((n) => n.id);

// SELF-TEST:
//   import { NEIGHBOR_IDS, neighborDef } from './src/data/neighbors.js'
//   NEIGHBOR_IDS  -> ['sheila','colonel','frog','marge','dwayne','newlyweds','previous']
//   neighborDef('sheila').relay === 'hub'
//   Every def has likes/hates/voice; no def contains a digit in any voice string.
