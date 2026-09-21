# Complete show-preparation rehearsal

Exercise the current compiled control room from capture and RSS import through context editing, saved-show creation, explicit activation and playback. Prioritize inserting a new topic with context while playback continues, including phone controls and reload persistence.

Use disposable local data and loopback fixtures. Preparation must leave the live timer unchanged; notes must remain off the overlay. Fix observed gaps and verify them through the running system before proceeding to the next documented feature. No live AI calls or deployment in this rehearsal.

Evidence: /private/tmp/dienda/rundown-rehearsal/evidence. Status: passed. The complete desktop and 390px touch flow passed against the compiled UI. Capture/import/context/save left the live clock unchanged; activation cancellation preserved it; explicit activation cued paused; instant insert-next with private context preserved the playing segment deadline; phone playback/reload and overlay privacy passed. Evidence: result.json and rehearse.py. Initial harness assertions were corrected for normal clock polling timestamps and lowercase success text; no product defect was found.
