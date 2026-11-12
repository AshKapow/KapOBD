# KapOBD

**Read your car's live data and fault codes from your phone.** KapOBD is a web app that talks to a car's OBD-II port through an inexpensive Bluetooth LE adapter. It runs on iPhone and iPad (in the Bluefy browser) and in Chrome on Android and computers. You don't need an account, and nothing is uploaded anywhere.

**Open the app:** https://ashkapow.github.io/KapOBD/ (no adapter yet? Tap **Try a demo with a simulated car** to look around first).

- **Live data:** speed, RPM, temperatures, battery voltage, fuel level, hybrid battery and more. It only shows what your car actually reports. *(For now you can read every value once; a live dashboard is coming soon.)*
- **Vehicle check:** the warning-light status, how many fault codes are stored, and the readiness monitors, which tell you whether an emissions test (e.g. an MOT) is likely to pass.
- **Fault codes:** stored, pending and permanent, with plain-English descriptions *(coming soon)*.
- **Several cars:** each car is remembered by its VIN, and you can give it a name.
- **Read-only by design.** See [Safety](#safety).

KapOBD is an early version. Connecting, reading what the car supports and reading values all work now. A live dashboard and the fault-code screens are on the way.

---

## What you need

| | |
|---|---|
| **An adapter** | An ELM327-compatible OBD-II adapter that uses **Bluetooth LE**, often sold as "Bluetooth 4.0", "BLE" or "works with iPhone". KapOBD is developed with the Veepeak OBDCheck BLE+, and most other BLE adapters should work too. |
| **Won't work** | "Classic" Bluetooth adapters (most cheap blue ELM327 dongles; they only pair with Android) and Wi-Fi adapters. Web browsers can only talk to Bluetooth **LE** devices. |
| **On iPhone / iPad** | The free **Bluefy – Web BLE Browser** app from the App Store. Safari can't use Bluetooth. |
| **On Android** | Chrome. |
| **On a computer** | Chrome or Edge. Firefox and Safari can't use Bluetooth. |
| **A car** | Any car with a standard OBD-II port: in the UK and Europe, petrol cars from 2001 and diesels from 2004; in the US, cars from 1996. All the usual protocols are supported (CAN, K-line/KWP2000 and J1850). |

A generic OBD tool like this sees engine and emissions data. It can't reach airbag, ABS, body or other manufacturer-specific systems. Some newer cars also have a "security gateway" that blocks clearing fault codes; KapOBD will tell you if that happens.

---

## Getting started on iPhone or iPad

1. Install **Bluefy – Web BLE Browser** from the App Store.
2. **Don't** pair the adapter in *Settings → Bluetooth*. Bluetooth LE adapters connect from inside the app, and pairing in Settings can stop that working. If you've already paired it, tap ⓘ next to it and choose *Forget This Device*.
3. In Bluefy, open https://ashkapow.github.io/KapOBD/ and bookmark it so it's one tap away next time.
   - Don't use Safari's *Add to Home Screen*: that opens the page in Safari, which has no Bluetooth.
4. The first time you tap **Connect to adapter**, iOS asks whether Bluefy may use Bluetooth. Allow it. If you said no earlier, turn it back on in *Settings → Bluefy → Bluetooth*.

## Getting started on Android or a computer

Open https://ashkapow.github.io/KapOBD/ with Bluetooth turned on: in Chrome on Android, or in Chrome or Edge on a computer. On Android you can add it to your home screen from the browser menu.

---

## Using it

1. Plug the adapter into the car's OBD port. It's usually under the dashboard on the driver's side, within about 60 cm of the steering wheel; your car's handbook shows exactly where.
2. Switch the ignition on. The engine can stay off.
3. Open KapOBD and tap **Connect to adapter**, then pick your adapter from the list.
   - If it isn't listed, tick *Show all Bluetooth devices* and try again.
4. Wait while KapOBD sets up the adapter and asks the car what it supports (up to about 20 seconds). You'll see the adapter's name, the protocol, the car's computers that answered, and the VIN.
5. Open **Vehicle** to see what your car supports, whether the warning light is on, and the readiness monitors. **Read every value once** reads each supported value.
6. Under *Saved vehicles*, use **Rename** to give each car a name you'll recognise.

### Tips

- **Hybrids:** the engine is often off while the car is on, so RPM 0 or some missing engine values are normal.
- Keep the screen on while you use it. Phones can drop the Bluetooth connection when the browser goes into the background or the screen locks.
- Unplug the adapter when you've finished. Some adapters stay powered and can slowly drain the car battery.
- **No adapter yet?** Tap **Try a demo with a simulated car** on the Connect screen to look around first. The demo values are made up and nothing is saved.

---

## Reporting a problem

If something doesn't work with your car or adapter:

1. Open **Console** and tap **Copy log**. **Share** and **Download** also work.
2. [Open an issue](https://github.com/AshKapow/KapOBD/issues) saying which car (make, model, year, petrol/diesel/hybrid) and which adapter you used, and paste the log.

The log contains your car's VIN. Remove it before posting if you'd rather keep it private.

If the page reloaded or the browser closed, the previous session's log is under **Console → Previous session log**.

---

## Privacy

Everything stays on your device. KapOBD has no server, accounts, tracking or analytics. Vehicle profiles, settings and the last log are kept in your browser's storage, and clearing the browser's data removes them.

---

## Safety

KapOBD only ever sends:

- adapter setup commands (`AT…`), except a few that could reconfigure or flood the adapter
- the read-only OBD-II requests for live data, freeze-frame data, fault codes and the VIN (modes `01`, `02`, `03`, `07`, `09` and `0A`)

Clearing fault codes (mode `04`) will only be possible through a dedicated screen with warnings and two confirmations. It's never sent from the Console and never retried automatically. Anything that could write to, reset or unlock a car's computers is refused before it reaches the adapter.

**Disclaimer:** KapOBD reads standard diagnostic data and is not a substitute for professional diagnosis. Clearing codes doesn't repair faults. Don't use the app while driving.

---

## Running your own copy

KapOBD is plain HTML and JavaScript with no build step. [Download the code](https://github.com/AshKapow/KapOBD/archive/refs/heads/main.zip), unzip it, and with [Node.js](https://nodejs.org) installed run:

```bash
node tools/serve.js
```

Then open http://localhost:8080 in Chrome on the same computer.

To test without a car, open http://localhost:8080/?dev instead. Developer mode adds several simulated cars (hybrid, petrol, older K-line petrol and diesel) and options to inject errors. Run the tests with `node --test`.
