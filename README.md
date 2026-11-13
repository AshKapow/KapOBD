# KapOBD

**Read your car's live data and fault codes from your phone.** KapOBD is a web app that talks to a car's OBD-II port through an inexpensive Bluetooth LE adapter. It runs on iPhone and iPad (in the Bluefy browser) and in Chrome on Android and computers. You don't need an account, and nothing is uploaded anywhere.

**Open the app:** https://ashkapow.github.io/KapOBD/ (no adapter yet? Tap **Try a demo with a simulated car** to look around first).

- **Live dashboard:** speed, RPM, temperatures, battery voltage, fuel level, hybrid battery and more, updating several times a second with a trend graph on each value. It only shows what your car actually reports.
- **Driving view:** up to four values in huge numbers, with nothing fiddly to tap.
- **Vehicle check:** the warning-light status, how many fault codes are stored, and the readiness monitors, which tell you whether an emissions test (e.g. an MOT) is likely to pass.
- **Fault codes:** stored, pending and permanent, with plain-English descriptions and the freeze frame (what the engine was doing when the fault happened).
- **Clear codes:** turn the warning light off after a repair, with clear warnings, an engine-off check and two confirmations first.
- **Self-test results:** the car's own pass/fail figures for its emissions checks (catalyst, O2 sensors, misfire counts), which can show a problem developing before a fault code appears.
- **Health report:** a tidy one-page summary of the car (codes, readiness, battery, values) to share, save or print.
- **Battery and charging test:** resting voltage, the dip while starting, and charging voltage.
- **Vehicle details:** make and region from the VIN, and each of the car's computers by name.
- **Code history and maintenance log:** see whether a code keeps coming back, and keep service and MOT dates with reminders.
- **Several cars:** each car is remembered by its VIN, and you can give it a name.
- **Read-only by design.** See [Safety](#safety).

KapOBD is an early version: the live dashboard and reading and clearing fault codes all work now. Recording drives and trip summaries are on the way.

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

### Live data

1. Open **Live**. KapOBD starts reading the car's values straight away and keeps going while the Live screen is open.
2. Each tile shows the latest value and a small graph of the last minute. A greyed-out value means the car hasn't answered for a few seconds.
3. Tap a tile for a big graph of the last minute or five minutes. Touch the graph to read the value at any moment, with the lowest, highest and average underneath.
4. **Choose values** picks which tiles to show (up to eight, saved for each car) and sets the units: mph or km/h, °C or °F, miles or km.
5. **Driving view** shows the first four tiles in large numbers with nothing else on screen. If the Live screen is open when the car starts moving (above 5 mph for a few seconds), KapOBD switches to it by itself, so there's nothing to tap on the road. You can turn that off under **Choose values**. Set everything up before you drive, keep the phone in a holder, and don't use it while driving.

On hybrids, the badge at the top shows when the engine is off and the car is driving on electric power. Engine values like RPM often stop updating while the engine is off; that's normal.

### Fault codes

1. Open **Codes** and tap **Read fault codes**.
2. You'll see whether the engine warning light is on, then:
   - **Stored** codes: confirmed faults. These usually turn the warning light on.
   - **Pending** codes: faults seen once but not yet confirmed.
   - **Permanent** codes: only the car can remove these, once the fault is fixed.
   - **Readiness:** whether the car's emissions self-checks have completed.
   - **Freeze frame:** what the engine was doing when the fault was stored.
3. To clear codes after a repair, tap **Clear codes…** and follow the three steps: read the warnings, switch the engine off with the ignition on (KapOBD checks), then tap **Clear codes now** twice. KapOBD reads the codes again afterwards to check.

Clearing codes doesn't fix anything; if the fault is still there, the code comes back. It also resets the readiness monitors, so an emissions test (such as an MOT) may fail until the car has been driven for a few days. Some cars with a security gateway refuse to clear codes with a generic tool. KapOBD tells you if that happens and never tries again on its own.

### Self-test results and code history

On **Codes**, **Read self-test results** shows the car's own emissions-check results, grouped by system, with any outside the car's limits listed first. Some results are in units KapOBD doesn't recognise; they're shown as raw numbers, but pass or fail is still correct.

Each time you read a car's codes, KapOBD keeps a history for that car: when each code was first and last seen, and whether it went away or came back. For self-checks that aren't complete, the Codes screen suggests the kind of driving that usually completes them.

### Vehicle tools

On **Vehicle**:

- **Create health report** reads the codes, readiness, self-tests and (optionally) every current value, and produces a one-page report. **Share** it, **Download** it, **Copy as text**, or **Print** it to save as a PDF. It includes the VIN; remove it before posting publicly if you'd rather keep it private.
- **Battery test** checks the 12 V battery in three steps: resting voltage with the engine off, the dip while you start the engine, and the charging voltage once it's running. On hybrids and electric cars, tick the option to skip the starting step. It's a quick check using rules of thumb; a garage load test is the definitive answer.
- **Maintenance** keeps dated entries (service, MOT, tyres and so on) and the next MOT and service dates. Reminders appear on the Vehicle screen when they're due within 30 days.
- **Computers** lists each of the car's computers by name, with calibration IDs and how often each self-check has completed.

### Tips

- **Hybrids:** the engine is often off while the car is on, so RPM 0 or some missing engine values are normal.
- **No signal?** After you've opened KapOBD once with a connection, it keeps a copy on your device and opens without a signal, which is handy in car parks and garages. This works in Chrome and Edge (including on Android). Some iPhone browsers don't allow it; **About** shows whether it's available in yours.
- Keep the screen on while you use it. Phones can drop the Bluetooth connection when the browser goes into the background or the screen locks.
- Unplug the adapter when you've finished. Some adapters stay powered and can slowly drain the car battery.
- **No adapter yet?** Tap **Try a demo with a simulated car** on the Connect screen to look around first. The demo car starts parked; on the Live screen, tap **Start a demo drive** to see the values move. The demo values are made up and nothing is saved.

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
- the read-only OBD-II requests for live data, freeze-frame data, fault codes, self-test results and vehicle information (modes `01`, `02`, `03`, `06`, `07`, `09` and `0A`)
- the adapter's own battery-voltage reading (`ATRV`) for the battery test

Clearing fault codes (mode `04`) is only possible from the **Codes** screen, after the warnings, an engine-off check and two confirmations. It's sent once, never from the Console, and never retried automatically. Anything that could write to, reset or unlock a car's computers is refused before it reaches the adapter.

**Disclaimer:** KapOBD reads standard diagnostic data and is not a substitute for professional diagnosis. Clearing codes doesn't repair faults. Don't use the app while driving.

---

## Running your own copy

KapOBD is plain HTML and JavaScript with no build step. [Download the code](https://github.com/AshKapow/KapOBD/archive/refs/heads/main.zip), unzip it, and with [Node.js](https://nodejs.org) installed run:

```bash
node tools/serve.js
```

Then open http://localhost:8080 in Chrome on the same computer.

To test without a car, open http://localhost:8080/?dev instead. Developer mode adds several simulated cars (hybrid, petrol, older K-line petrol and diesel) and options to inject errors. Run the tests with `node --test`.
