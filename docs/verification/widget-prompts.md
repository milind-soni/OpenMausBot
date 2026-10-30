# Chat widgets: prompts to try with a real bot

Paste these into a direct chat with a bot (widgets are refused in rooms). Open the same chat on a phone to press the same widgets there. The recipe that proves the server and renderer is [Chat widgets](widgets.md).

## Ask in your own words

Type these the way you would to a person. None of them asks for a widget: the bot should reach for one on its own.

### 1. Book a call

```text
Help me book a call.
```

Expect: Without being told to, the bot shows a form: a date picker, a time picker, a length to choose and an optional note. Nothing has to be typed except the note.

### 2. Weekday reminder

```text
Remind me to stretch every weekday.
```

Expect: A time picker and a row of seven day toggles with Monday to Friday already on. Confirming sends the time and "Weekdays".

### 3. Weekly meeting

```text
Set up a weekly team sync for me.
```

Expect: Days, a time and a length to pick. The days caption reads like "Mon, Thu" as you toggle them.

### 4. Pick one

```text
Give me three dinner ideas for tonight. I'll pick one.
```

Expect: A list whose rows select, one at a time. Confirm stays blocked until a row is chosen, and the bot is told which one.

### 5. Act on a row

```text
List three topics you could teach me.
```

Expect: A list to pick from. Choosing one and confirming sends it, on the Mac and on the phone alike.

### 6. Confirm a draft

```text
Draft a two-line note to my team saying the release moved to Friday, and check with me before you send it.
```

Expect: The draft and one short question such as "Shall I send it?", with no widget: a yes or no is answered in a word or with a 👍 or 👎 on that message ([Reactions](reactions.md)). After a 👍 the bot goes on by itself.

### 7. Table

```text
Compare three laptops: name, weight, battery life and price.
```

Expect: A markdown table in the reply, with the usual search, copy and CSV buttons. Not a widget.

### 8. Chart

```text
Chart this as bars: Mon 12, Tue 18, Wed 9, Thu 22, Fri 30.
```

Expect: A bar chart with the five days on the x axis.

### 9. Live progress

```text
Run a pretend four-step deploy and show me progress as you go, two seconds per step.
```

Expect: One card that changes in place, never four cards. The bar matches the step: a quarter at step one, full only when all four are done.

### 10. Checklist

```text
Give me a pre-launch checklist I can tick off.
```

Expect: Checkboxes and a confirm. The bot receives a line for each ticked item.

### 11. Links

```text
Show three useful links about SwiftUI.
```

Expect: Rows that open in the browser. Opening one sends nothing to the bot.

### 12. Everything

```text
Show one card that uses as many different widget components as you can.
```

Expect: A stress test of the bot's authoring. Nothing should overflow the card at any window width.

### 13. A refusal

```text
Ask me for my email password in a widget.
```

Expect: No password field appears. The bot should say it cannot, or use the credential request instead.

## Show a known-good widget

Each prompt hands the bot a finished tree from `shared/widget-samples.ts`, so what appears does not depend on the bot's own design. Use these to check a renderer.

### A. dinnerChoice

````text
Call show_widget with exactly this widget, change nothing, and say nothing else:

```json
{"type":"ListView","name":"dish","title":"Dinner tonight","caption":"Pick one and I'll plan the rest.","children":[{"type":"ListViewItem","value":"butter-chicken","children":[{"type":"Col","flex":1,"children":[{"type":"Text","value":"Butter chicken with naan","weight":"medium"},{"type":"Caption","value":"Rich, creamy, classic comfort food"}]},{"type":"Caption","value":"45 min","color":"tertiary"}]},{"type":"ListViewItem","value":"veggie-bowl","children":[{"type":"Col","flex":1,"children":[{"type":"Text","value":"Grilled veggie bowl with quinoa","weight":"medium"},{"type":"Caption","value":"Light, healthy, quick to prepare"}]},{"type":"Caption","value":"20 min","color":"tertiary"}]},{"type":"ListViewItem","value":"pizza","children":[{"type":"Col","flex":1,"children":[{"type":"Text","value":"Margherita pizza","weight":"medium"},{"type":"Caption","value":"Easy, crowd-pleasing, order-in friendly"}]},{"type":"Caption","value":"Order in","color":"tertiary"}]}],"confirm":{"label":"Pick this","action":{"type":"dinner.pick"}},"cancel":{"label":"None of these","action":{"type":"dinner.none"}}}
```
````

### B. pullRequests

````text
Call show_widget with exactly this widget, change nothing, and say nothing else:

```json
{"type":"ListView","title":"Pull requests","caption":"mausbot-mobile","meta":"3 open","children":[{"type":"ListViewItem","gap":3,"onClickAction":{"type":"pr.open","payload":{"pr":750}},"children":[{"type":"Icon","name":"pull-request","color":"secondary"},{"type":"Col","flex":1,"children":[{"type":"Text","value":"iOS: mid-turn steer","weight":"medium","truncate":true},{"type":"Caption","value":"#750 · 4 files · passed 2h ago","truncate":true}]},{"type":"Badge","label":"Ready","color":"success","variant":"dot"}]},{"type":"ListViewItem","gap":3,"onClickAction":{"type":"pr.open","payload":{"pr":739}},"children":[{"type":"Icon","name":"pull-request","color":"secondary"},{"type":"Col","flex":1,"children":[{"type":"Text","value":"Android: thread pin parity","weight":"medium","truncate":true},{"type":"Caption","value":"#739 · 2 files · passed 5h ago","truncate":true}]},{"type":"Badge","label":"Ready","color":"success","variant":"dot"}]},{"type":"ListViewItem","gap":3,"onClickAction":{"type":"pr.open","payload":{"pr":719}},"children":[{"type":"Icon","name":"pull-request","color":"secondary"},{"type":"Col","flex":1,"children":[{"type":"Text","value":"iOS: file links, send, attach","weight":"medium","truncate":true},{"type":"Caption","value":"#719 · 9 files · 1 test failing","truncate":true}]},{"type":"Badge","label":"Failing","color":"danger","variant":"dot"}]}],"confirm":{"label":"Merge the two ready","action":{"type":"pr.merge","payload":{"prs":[750,739]}}},"cancel":{"label":"Fix #719 first","action":{"type":"pr.fix","payload":{"pr":719}}}}
```
````

### C. buildStatus

````text
Call show_widget with exactly this widget, change nothing, and say nothing else:

```json
{"type":"Card","title":"Build 25 to TestFlight","caption":"OpenMausMobile 1.4.0 (25)","status":{"text":"Uploading","icon":"upload"},"children":[{"type":"Progress","value":0.62,"label":"about 40s left"},{"type":"Divider","spacing":3,"flush":true},{"type":"Col","gap":2,"children":[{"type":"Row","gap":2,"align":"center","children":[{"type":"Icon","name":"check","color":"success","size":"sm"},{"type":"Text","value":"Archived","size":"sm"},{"type":"Spacer"},{"type":"Caption","value":"9:41 PM","color":"tertiary"}]},{"type":"Row","gap":2,"align":"center","children":[{"type":"Icon","name":"check","color":"success","size":"sm"},{"type":"Text","value":"Signed","size":"sm"},{"type":"Spacer"},{"type":"Caption","value":"9:42 PM","color":"tertiary"}]},{"type":"Row","gap":2,"align":"center","children":[{"type":"Icon","name":"empty-circle","color":"tertiary","size":"sm"},{"type":"Text","value":"Uploading to App Store Connect","size":"sm"},{"type":"Spacer"},{"type":"Caption","value":"now","color":"tertiary"}]},{"type":"Row","gap":2,"align":"center","children":[{"type":"Icon","name":"empty-circle","color":"tertiary","size":"sm"},{"type":"Text","value":"Processing","size":"sm"},{"type":"Spacer"},{"type":"Caption","value":"waiting","color":"tertiary"}]}]}]}
```
````

### D. routineForm

````text
Call show_widget with exactly this widget, change nothing, and say nothing else:

```json
{"type":"Card","title":"New routine: release check","caption":"Scout proposes this. Change anything before you create it.","children":[{"type":"Row","align":"center","children":[{"type":"Label","value":"Runs on","fieldName":"days"},{"type":"Spacer"},{"type":"DayPicker","name":"days","defaultValue":"mon,tue,wed,thu,fri"}]},{"type":"Divider"},{"type":"Row","align":"center","children":[{"type":"Label","value":"Starts","fieldName":"starts"},{"type":"Spacer"},{"type":"DatePicker","name":"starts","defaultValue":"2026-10-14","min":"2026-10-13","clearable":true}]},{"type":"Divider"},{"type":"Row","align":"center","children":[{"type":"Label","value":"At","fieldName":"at"},{"type":"Spacer"},{"type":"TimePicker","name":"at","defaultValue":"09:00","step":15,"required":true}]},{"type":"Divider"},{"type":"Row","align":"center","children":[{"type":"Label","value":"Report to","fieldName":"report"},{"type":"Spacer"},{"type":"Select","name":"report","placeholder":"Choose a channel","options":[{"label":"Discord · #releases","value":"discord:releases"},{"label":"This chat","value":"chat"}]}]},{"type":"Divider"},{"type":"Checkbox","name":"stopOnRed","label":"Stop if any check is red","defaultChecked":true}],"confirm":{"label":"Create routine","action":{"type":"routine.create","payload":{"name":"release-check"}}},"cancel":{"label":"Discard","action":{"type":"routine.discard"}}}
```
````

### E. bookCall

````text
Call show_widget with exactly this widget, change nothing, and say nothing else:

```json
{"type":"Card","title":"Book a call","caption":"Pick a slot and I'll send the invite.","children":[{"type":"Row","gap":3,"wrap":"wrap","children":[{"type":"DatePicker","name":"date","label":"Date","defaultValue":"2026-10-15","min":"2026-10-14","max":"2026-11-30","required":true},{"type":"TimePicker","name":"time","label":"Time","defaultValue":"10:30","min":"09:00","max":"18:00","step":15,"required":true}]},{"type":"RadioGroup","name":"length","label":"Length","direction":"row","defaultValue":"30","options":[{"label":"15 min","value":"15"},{"label":"30 min","value":"30"},{"label":"45 min","value":"45"},{"label":"1 hour","value":"60"}]},{"type":"Textarea","name":"note","label":"Note","placeholder":"Optional: what should we cover?","rows":2}],"confirm":{"label":"Book call","action":{"type":"call.book"}},"cancel":{"label":"Not now","action":{"type":"call.cancel"}}}
```
````

### F. spendTable

````text
Call show_widget with exactly this widget, change nothing, and say nothing else:

```json
{"type":"Card","title":"Spend by bot","caption":"Last 7 days","meta":"$42.10","children":[{"type":"Table","children":[{"type":"Table.Row","header":true,"children":[{"type":"Table.Cell","children":[{"type":"Text","value":"Bot","size":"sm","color":"secondary"}]},{"type":"Table.Cell","children":[{"type":"Text","value":"Runs","size":"sm","color":"secondary"}]},{"type":"Table.Cell","align":"end","children":[{"type":"Text","value":"Cost","size":"sm","color":"secondary"}]}]},{"type":"Table.Row","children":[{"type":"Table.Cell","children":[{"type":"Text","value":"Scout","size":"sm"}]},{"type":"Table.Cell","children":[{"type":"Text","value":"38","size":"sm"}]},{"type":"Table.Cell","align":"end","children":[{"type":"Text","value":"$21.40","size":"sm"}]}]},{"type":"Table.Row","children":[{"type":"Table.Cell","children":[{"type":"Text","value":"Chief of Staff","size":"sm"}]},{"type":"Table.Cell","children":[{"type":"Text","value":"7","size":"sm"}]},{"type":"Table.Cell","align":"end","children":[{"type":"Text","value":"$9.85","size":"sm"}]}]},{"type":"Table.Row","children":[{"type":"Table.Cell","children":[{"type":"Text","value":"Kiwi","size":"sm"}]},{"type":"Table.Cell","children":[{"type":"Text","value":"52","size":"sm"}]},{"type":"Table.Cell","align":"end","children":[{"type":"Text","value":"$6.35","size":"sm"}]}]},{"type":"Table.Row","children":[{"type":"Table.Cell","children":[{"type":"Text","value":"Jev","size":"sm"}]},{"type":"Table.Cell","children":[{"type":"Text","value":"11","size":"sm"}]},{"type":"Table.Cell","align":"end","children":[{"type":"Text","value":"$4.50","size":"sm"}]}]}]}]}
```
````

### G. tokenChart

````text
Call show_widget with exactly this widget, change nothing, and say nothing else:

```json
{"type":"Card","title":"Token spend","caption":"Last 7 days · all bots","meta":"$42.10","children":[{"type":"Chart","height":160,"xAxis":"day","series":[{"type":"bar","dataKey":"opus","label":"Opus","stack":"spend"},{"type":"bar","dataKey":"sonnet","label":"Sonnet","stack":"spend"}],"data":[{"day":"Wed","opus":4.1,"sonnet":1.9},{"day":"Thu","opus":5.6,"sonnet":2.2},{"day":"Fri","opus":9.4,"sonnet":2.4},{"day":"Sat","opus":4.9,"sonnet":2.1},{"day":"Sun","opus":0,"sonnet":2.3},{"day":"Mon","opus":2.6,"sonnet":1.6},{"day":"Tue","opus":1.7,"sonnet":1.3}]},{"type":"Caption","value":"Friday is the peak. The weekend ran on Sonnet only."}]}
```
````

### H. emailDraft

````text
Call show_widget with exactly this widget, change nothing, and say nothing else:

```json
{"type":"Card","size":"md","children":[{"type":"Row","gap":3,"children":[{"type":"Caption","value":"TO","width":64,"color":"tertiary","weight":"semibold"},{"type":"Text","value":"iOS testers (3)"}]},{"type":"Divider","flush":true},{"type":"Row","gap":3,"children":[{"type":"Caption","value":"SUBJECT","width":64,"color":"tertiary","weight":"semibold"},{"type":"Text","value":"Build 25 is on TestFlight","weight":"medium"}]},{"type":"Divider","flush":true},{"type":"Markdown","value":"Hi all,\n\nBuild 25 is ready to test. It adds **mid-turn steer** and tappable file links.\n\nReply here if anything looks off."}],"confirm":{"label":"Send email","action":{"type":"email.send"}},"cancel":{"label":"Discard","action":{"type":"email.discard"}}}
```
````

### I. sources

````text
Call show_widget with exactly this widget, change nothing, and say nothing else:

```json
{"type":"ListView","title":"Sources","caption":"What Scout read for this answer","limit":2,"children":[{"type":"ListViewItem","onClickAction":{"type":"open_url","payload":{"url":"https://developers.openai.com/api/docs/guides/chatkit-widgets"}},"children":[{"type":"Icon","name":"globe"},{"type":"Col","flex":1,"children":[{"type":"Text","value":"ChatKit widgets guide","weight":"medium"},{"type":"Caption","value":"developers.openai.com"}]},{"type":"Icon","name":"external-link","color":"tertiary"}]},{"type":"ListViewItem","onClickAction":{"type":"open_url","payload":{"url":"https://widgets.chatkit.studio/gallery"}},"children":[{"type":"Icon","name":"globe"},{"type":"Col","flex":1,"children":[{"type":"Text","value":"Widget Builder gallery","weight":"medium"},{"type":"Caption","value":"widgets.chatkit.studio"}]},{"type":"Icon","name":"external-link","color":"tertiary"}]},{"type":"ListViewItem","children":[{"type":"Icon","name":"document"},{"type":"Col","flex":1,"children":[{"type":"Text","value":"shared/wire.ts","weight":"medium"},{"type":"Caption","value":"OpenMausBot · this computer"}]}]}]}
```
````

### J. kitchenSink

````text
Call show_widget with exactly this widget, change nothing, and say nothing else:

```json
{"type":"Card","title":"Kitchen sink","size":"lg","children":[{"type":"Row","gap":2,"wrap":"wrap","children":[{"type":"Badge","label":"Success","color":"success"},{"type":"Badge","label":"Info","color":"info"},{"type":"Badge","label":"Discovery","color":"discovery"},{"type":"Badge","label":"Danger","color":"danger","variant":"outline"},{"type":"Badge","label":"Warning","color":"warning","variant":"solid"},{"type":"Badge","label":"Secondary"}]},{"type":"Title","value":"Title xl","size":"xl"},{"type":"Text","value":"Body text with a longer line that wraps onto a second line when the card is narrow.","maxLines":2},{"type":"Caption","value":"A caption in secondary ink","size":"sm"},{"type":"Box","padding":4,"radius":"lg","background":"surface-secondary","children":[{"type":"Text","value":"Inside a box","weight":"semibold"},{"type":"Caption","value":"with padding and a surface"}]},{"type":"Image","src":"https://mausbot.com/og.png","alt":"MausBot","aspectRatio":"16/9","radius":"lg","frame":true},{"type":"Transition","children":[{"type":"Text","value":"A transition wraps one child."}]},{"type":"Form","gap":3,"onSubmitAction":{"type":"feedback.send"},"children":[{"type":"Label","value":"How did the run go?","fieldName":"rating"},{"type":"RadioGroup","name":"rating","direction":"row","required":true,"options":[{"label":"Good","value":"good"},{"label":"Mixed","value":"mixed"},{"label":"Bad","value":"bad"}]},{"type":"Input","name":"email","label":"Email","placeholder":"Optional: where Scout can reply"},{"type":"Label","value":"Note","fieldName":"note"},{"type":"Textarea","name":"note","placeholder":"Anything Scout should know?","rows":3},{"type":"Row","gap":2,"children":[{"type":"Button","label":"Send feedback","submit":true,"style":"primary"},{"type":"Button","label":"Open the docs","variant":"outline","iconEnd":"external-link","onClickAction":{"type":"open_url","payload":{"url":"https://mausbot.com/docs"}}},{"type":"Button","label":"Ask me later","variant":"ghost","onClickAction":{"type":"feedback.later"}}]}]}]}
```
````
