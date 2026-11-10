# Ripline FPV

Multiplayer FPV drone racing in the browser. Working title.

Up to eight pilots a heat. Acro mode with Betaflight Actual rates, camera uptilt, a 6S
battery that sags, and a start on the tone. Built with three.js. The server is one
Cloudflare Worker with Durable Objects, so it runs on the free tier.

Status: first playable slice, 11 Nov 2026.

## Run it

```
npm install
cp .dev.vars.example .dev.vars
npm run preview        # builds, then serves game and server on http://localhost:8787
```

For work on the client with hot reload, run `npm run server` in one terminal and
`npm run dev` in another, then open http://localhost:5173.

Tests:

```
npm test                      # flight model numbers and sign-in checks
node tests/room.test.mjs      # two pilots through a heat, needs the server running
```

Open the game with `?bot=1` to let a slow autopilot fly. It exists to prove the tracks
can be lapped.

## Controls

The game watches for a controller. Until one is used, it shows keyboard keys. Press any
button on a PlayStation or Xbox pad and the on-screen glyphs switch to that pad. Unplug it
and they go back to keyboard.

| Action | Keyboard | PlayStation | Xbox |
|---|---|---|---|
| Throttle and yaw | W S, A D | Left stick | Left stick |
| Pitch and roll | Arrow keys | Right stick | Right stick |
| Reset to the last gate | R | R1 | RB |
| FPV or chase camera | C | L1 | LB |
| Camera tilt | [ ] | D-pad up, down | D-pad up, down |
| Ready up | Enter | Cross | A |
| Restart (time trial) | Backspace | Create | View |
| Menu | Esc | Options | Menu |
| Acro or angle | M | Settings | Settings |

Sticks are mode 2 by default. Modes 1, 3 and 4 are in Settings.

Pad sticks spring back to the centre, and a real radio's throttle does not. So the default
throttle setting puts hover at the centre of the stick. Pilots who want it the real way
can pick "Full travel, like a radio". There is also an upper-half option and a trigger
option.

USB radios (anything the browser reports as a non-standard gamepad) work too. Open
Settings, press "Map radio sticks", and move each stick when asked.

Hold Shift on the keyboard for smaller stick movements.

## Flight model

`src/physics.js`, 500 Hz fixed step.

- 5 inch quad, 620 g, thrust to weight 7.8.
- Rates: Betaflight Actual (centre sensitivity, max rate, expo) per axis. Default 70 / 670 / 0.
- Thrust falls off with inflow through the props, so the quad tops out near 125 km/h.
- Drag differs by axis. The top plate is draggier than the nose.
- Motors take time to spool up and longer to spool down.
- Battery: voltage sags under load and as the pack drains. Less volts means less thrust.
- Propwash shake when you drop into your own air.
- Angle mode is there for first flights. Acro is the default.

## Racing

- Quick race puts you in an open room for that track, or opens a new one.
- Private room gives you a code and a link to share.
- You can fly while you wait. The heat starts when every pilot is ready.
- Start: "Arm your quads. Going live on the tone in less than five." The server picks the
  moment at random, 4 to 7.5 seconds out.
- Three laps. The rest of the field gets 30 seconds after the winner.
- Time trial is solo. The clock starts at the first gate and your best lap flies along as
  a ghost.

Pilots do not collide with each other. Gates do.

The client reports its own gate times. The server checks gate order, that the times track
its own clock, and that no lap is faster than a floor set per track. That stops casual
cheating. It will not stop a determined one.

## Google sign-in

1. In Google Cloud Console, create an OAuth client ID of type "Web application".
2. Add your site's origin under "Authorised JavaScript origins" (and
   `http://localhost:8787` for local runs).
3. Put the client ID in `wrangler.toml` as `GOOGLE_CLIENT_ID`.
4. Set `ALLOW_GUESTS = "false"` if only signed-in pilots should race.

The page shows Google's own button. The Worker checks the ID token against Google's keys
(signature, issuer, audience, expiry), then sets its own session cookie (HttpOnly, 30
days). The room socket only opens with that cookie. Only signed-in pilots go on the best
lap board.

With no client ID set, the game runs with guest pilots only.

## Deploy

```
npx wrangler login
npx wrangler secret put SESSION_SECRET     # any long random string
npm run deploy
```

Durable Objects bill by request, and incoming socket messages count at 20 to 1. Eight
pilots sending 15 poses a second is about 6 billed requests a second. The free plan's
100,000 a day covers roughly four and a half hours of full eight-pilot heats.

## Layout

```
index.html            page, menus, OSD
src/main.js           game loop, race logic, screens
src/physics.js        flight model
src/input.js          keyboard, pads, radios
src/glyphs.js         button glyphs, drawn as SVG
src/world.js          field, gates, colliders
src/drone.js          quad model loading
src/audio.js          motor sound and tones
src/net.js            server calls and the room socket
shared/tracks.js      track data, used by client and server
worker/index.js       routes
worker/auth.js        Google token check, session cookie
worker/room.js        one race room (Durable Object)
worker/hub.js         open rooms and best laps (Durable Object)
```

## Not done yet

- Only two tracks. No track editor.
- No voice or chat.
- Phones are not supported. There are no touch sticks.
- The best lap board takes laps from online heats only.
- Real Google sign-in has not been run end to end. It needs a client ID first. The token
  check is covered by tests with a local key.

## Credits

Quad model by eagleanurag, CC BY 4.0. See [CREDITS.md](CREDITS.md).
