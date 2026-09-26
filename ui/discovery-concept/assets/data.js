// Rundown discovery concept — sample stories only. Nothing here is real.
// Four source kinds: article, youtube, tiktok, reddit. Four topics: film, design, tech, sport.
window.RUNDOWN_STORIES = [
  {
    id: "oner", source: "article", topic: "film",
    title: "Why the long take came back",
    dek: "Ten years ago a five-minute shot was a stunt. Now it is a scheduling decision.",
    body: [
      "Directors used to hide cuts inside whip pans and doorways. Today the reason to hold a shot is simpler: a camera that can move like a person and a crew that rehearses a scene like a play.",
      "The trick is not the technology. It is deciding what the audience should feel when nothing is allowed to interrupt them."
    ],
    takeaways: ["Long takes are now planned in pre-production, not improvised", "Stabilisers changed the cost, rehearsal changed the craft", "The best ones make you forget there was a choice"],
    meta: { outlet: "Frame & Field", author: "Ines Okafor", minutes: 4, url: "frameandfield.example/long-take" },
    art: { kind: "arc", palette: 0 }
  },
  {
    id: "grid", source: "youtube", topic: "design",
    title: "The grid that ran a newspaper for forty years",
    dek: "A video essay on the twelve-column system one Zurich daily never abandoned.",
    body: [
      "The system had two rules: every element sits on the grid, and the grid is never shown. Editors argued with it, photographers hated it, and readers never noticed it was there.",
      "The essay's best moment is a side-by-side of two front pages, one broken, one obedient. You can feel the difference before you can name it."
    ],
    takeaways: ["Constraints that survive decades are the ones nobody sees", "Break the grid once per page, on purpose", "Typographic rhythm is a reading speed, not a look"],
    meta: { channel: "Set in Metal", duration: "11:42", views: "412K views", url: "youtube.example/watch?v=grid-40" },
    art: { kind: "grid", palette: 1 }
  },
  {
    id: "serve", source: "tiktok", topic: "sport",
    title: "The forty-second serve routine",
    dek: "A touring pro breaks down the ritual before every serve, bounce by bounce.",
    body: [
      "Four bounces, a breath out, a look at the target, then nothing. The routine is not superstition; it is a way of making every serve start from the same place.",
      "The clip went wide because it made an invisible habit visible. Watch any match afterwards and you will count the bounces."
    ],
    takeaways: ["Routines make pressure moments feel like practice", "The pause before the toss is the whole point", "Consistency beats intensity"],
    meta: { creator: "@courtside.ana", duration: "0:41", likes: "1.2M", url: "tiktok.example/@courtside.ana/serve" },
    art: { kind: "orbit", palette: 2 }
  },
  {
    id: "fans", source: "reddit", topic: "tech",
    title: "Why your laptop fan spins on a blank page",
    dek: "A compositor engineer explains the thread that hit the front page of r/hardware.",
    body: [
      "A blank tab still repaints at sixty frames a second if something on the page thinks it is animating. The culprit is usually a cursor blink or a promotional banner that never stopped moving.",
      "The reply that made the thread was a one-line fix: stop scheduling frames when nothing changed. Most apps never check."
    ],
    takeaways: ["Idle is a state you have to design for", "Most 'heavy' pages are just noisy pages", "Measure frames, not features"],
    meta: { sub: "r/hardware", op: "u/vsync_or_die", upvotes: "18.4k", comments: "1,203", url: "reddit.example/r/hardware/blank-page-fan" },
    art: { kind: "stripes", palette: 3 }
  },
  {
    id: "offwhite", source: "article", topic: "design",
    title: "Off-white is a decision",
    dek: "Paper makers, gallery painters and screen designers on the colour nobody thinks they chose.",
    body: [
      "Pure white is a lab value; off-white is a temperature. Museums warm their walls by a few points so paintings do not look cold. Paper mills do the same for the eye at reading distance.",
      "On screens the choice is stranger, because the light comes from behind. A warm surface lowers contrast slightly and asks the type to do more of the work."
    ],
    takeaways: ["Warmth is a reading comfort setting", "Contrast is a budget, spend it on the words", "If you did not choose the white, someone else did"],
    meta: { outlet: "Surface Notes", author: "Tomas Reyes", minutes: 6, url: "surfacenotes.example/off-white" },
    art: { kind: "blob", palette: 4 }
  },
  {
    id: "foley", source: "youtube", topic: "film",
    title: "How a foley artist builds a footstep",
    dek: "Seven minutes inside a pit of gravel, a pair of borrowed boots and a lot of listening.",
    body: [
      "Every footstep in a film is performed twice: once by the actor and once by someone watching the actor on a monitor, walking in place on the right surface.",
      "The surprise is how much character lives in the weight. Hesitation, confidence and exhaustion are all in the heel."
    ],
    takeaways: ["Sound is acted, not captured", "Surfaces are a costume for the feet", "Silence is recorded too"],
    meta: { channel: "Below the Line", duration: "7:18", views: "980K views", url: "youtube.example/watch?v=foley-step" },
    art: { kind: "diagonal", palette: 5 }
  },
  {
    id: "kerning", source: "tiktok", topic: "design",
    title: "Kerning in twelve seconds",
    dek: "A type designer fixes a shop sign with a finger and a marker.",
    body: [
      "The clip is a single move: a letter slides left, the word suddenly reads. No jargon, no history, just the moment the gap closes.",
      "It works because it shows the failure first. Once you have seen an 'AV' too wide apart you cannot unsee it."
    ],
    takeaways: ["Show the wrong version before the right one", "Spacing is read, not seen", "Small fixes travel further than lectures"],
    meta: { creator: "@letter.press", duration: "0:12", likes: "3.4M", url: "tiktok.example/@letter.press/kern" },
    art: { kind: "grid", palette: 0 }
  },
  {
    id: "aero", source: "reddit", topic: "sport",
    title: "The aero-versus-weight post that changed group rides",
    dek: "A materials engineer ran the numbers for a club ride and the thread has 4,000 replies.",
    body: [
      "On a flat loop, drag costs more than mass by a wide margin. The post's spreadsheet showed that a rider's position saves more watts than any part they can buy.",
      "The comment section split between people who felt vindicated and people who had just ordered wheels."
    ],
    takeaways: ["Position first, equipment second", "Numbers end arguments only if everyone reads them", "Comfort is aerodynamic when it lasts three hours"],
    meta: { sub: "r/cycling", op: "u/cdA_curious", upvotes: "9.7k", comments: "4,012", url: "reddit.example/r/cycling/aero-vs-weight" },
    art: { kind: "orbit", palette: 1 }
  },
  {
    id: "smallweb", source: "article", topic: "tech",
    title: "The quiet return of the small web",
    dek: "Personal sites, webrings and a generation that never saw the first one.",
    body: [
      "The new small web is not nostalgic. It is a reaction to feeds that decide for you, built by people who want a page that is theirs and loads in a blink.",
      "Its tools are old and boring on purpose: plain HTML, a folder of files, a link to a friend."
    ],
    takeaways: ["Ownership is a feature people will trade reach for", "Boring technology ages well", "A link is still the best recommendation"],
    meta: { outlet: "Hinterland", author: "Mei Lindqvist", minutes: 5, url: "hinterland.example/small-web" },
    art: { kind: "stripes", palette: 2 }
  },
  {
    id: "zone2", source: "youtube", topic: "sport",
    title: "What the zone-two obsession gets right",
    dek: "A coach separates the physiology from the podcast noise in nine minutes.",
    body: [
      "Easy miles build the engine that hard miles use. That part is true. The part that got lost is that 'easy' means conversational, not slow by the numbers on a watch.",
      "The video ends with a useful test: if you cannot say a full sentence, you are not in the zone you think you are."
    ],
    takeaways: ["Most people train too hard on easy days", "Talk test beats heart-rate zones for beginners", "Volume is the variable that matters"],
    meta: { channel: "Long Way Round", duration: "9:04", views: "256K views", url: "youtube.example/watch?v=zone2" },
    art: { kind: "arc", palette: 3 }
  },
  {
    id: "thumb", source: "tiktok", topic: "tech",
    title: "One thumb, one hand",
    dek: "A designer maps where a thumb can actually reach on a tall phone. It is less than you think.",
    body: [
      "The clip overlays a heat map on a phone: the bottom third is easy, the middle is a stretch, the top corners are a two-handed job.",
      "Then it flips through popular apps and shows where the important buttons are. The laughter in the comments is the point."
    ],
    takeaways: ["Put the next action where the thumb already is", "Top corners are for things you rarely need", "Reach is a constraint, not a preference"],
    meta: { creator: "@reach.zone", duration: "0:27", likes: "860K", url: "tiktok.example/@reach.zone/thumb" },
    art: { kind: "blob", palette: 5 }
  },
  {
    id: "dim", source: "reddit", topic: "film",
    title: "A projectionist explains why the theatre looked dim",
    dek: "The most upvoted comment in r/movies this month is a maintenance schedule.",
    body: [
      "Projector lamps fade slowly and get replaced late. Many cinemas also leave a 3D filter in place for 2D screenings, which cuts brightness roughly in half.",
      "The thread turned into a crowd-sourced list of which chains fix it and which do not. The projectionist's advice: ask at the desk, politely, and they usually can."
    ],
    takeaways: ["Dim screens are a maintenance problem, not a style", "3D filters left in place are the common culprit", "Asking works more often than complaining online"],
    meta: { sub: "r/movies", op: "u/booth_ghost", upvotes: "22.1k", comments: "2,640", url: "reddit.example/r/movies/dim-theatre" },
    art: { kind: "diagonal", palette: 4 }
  }
];
