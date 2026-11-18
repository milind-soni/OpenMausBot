# Proposal: install an APK on an already-paired Android device

A developer finishes a build on their computer and asks their bot to update the app on their phone. The phone is already connected to that computer through Android Wireless debugging on the local Wi-Fi network. OpenMausBot should be able to deliver the build and tell the developer which version Android installed while the developer continues using the phone.

Today the [desktop Android device code](../electron/android-device.mjs) filters the device list to USB, and the [phone harness](../skills/phone-harness/SKILL.md) provides screen interaction. This proposal adds a package installation action to that supported interface. Screen interaction would still be a separate request.

## Proposed interaction

1. The user identifies the APK and the target phone. The desktop resolves a local file available to the task and reads its package name, version code, signer and digest. The existing approval policy applies to that artifact, target and action.
2. For a direct Wi-Fi request, use an existing authenticated Android Wireless debugging connection to the selected phone. Pairing remains a user-managed prerequisite. If the connection cannot be verified or two phones match, stop before installation and explain what needs resolving. The request must never silently switch to a USB cable, tunnel or another phone.
3. Install the approved bytes. For an existing app, use Android’s in-place update semantics so its data is retained. Surface Android’s rejection for an incompatible signer, downgrade or device policy. Keep the current app installed on failure.
4. Read back the package name and version code on the same device and compare them with the artifact. Distinguish an installation rejection from a successful install whose verification was interrupted. Return the result in chat without opening the app, waking the screen, or navigating Files or Settings.

## Acceptance cases for an implementation

| Situation | Expected result |
| --- | --- |
| An authorized, paired phone has an older compatible build | The update succeeds, existing app data survives, and the result names the installed package and version. The screen can stay off. |
| USB and Wi-Fi both identify the same physical phone | A direct Wi-Fi request uses only the selected Wi-Fi transport. |
| The phone is offline, unpaired, ambiguous, or reachable only by an unverified network path | No install is attempted. The result explains which prerequisite is missing. |
| The APK changes after approval, or Android rejects the update | The changed artifact is refused or Android’s error is reported. The bot never retries by uninstalling the existing app. |
| The device disconnects after installation but before readback | The result states that verification is pending. A retry first checks what is already installed. |

The proposed action accepts one APK and one device. Arbitrary shell commands, address-range scans, automatic pairing, and screen-control fallback are outside its scope.
