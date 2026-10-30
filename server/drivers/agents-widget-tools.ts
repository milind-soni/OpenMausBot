// The chat-widget tool of the agents catalog: definitions only, sent to the model on every turn.
export const WIDGET_TOOL_DEFINITIONS = [
  {
    name: "show_widget",
    description:
      "Show an interactive widget in this chat: one question answered with a tap instead of typing (a time, a day, one of a few options), a form prefilled (defaultValue) with what they want to change, or a live status. Ask only what you cannot find or sensibly default, one question per widget; for a pick-one, a Card with a Row of Buttons, one per option (onClickAction sends it in one tap), at most six. Several fields only to change something that exists, or for required details you cannot default; \"remind me every weekday\" gets a TimePicker and a DayPicker. A plain yes or no needs none: ask it in your message, and a word or a 👍 or 👎 answers it. Data, comparisons and results go in a markdown table in your message instead, which the chat can copy and export. `widget` is one JSON tree. The root is {type:\"Card\"|\"ListView\", title?, caption?, children:[...], confirm?:{label,action}, cancel?:{label,action}}. Nodes: Row, Col, Box, Spacer, Divider, Text, Title, Caption, Markdown, Badge{label,color}, Icon{name}, Image{src}, Progress{value 0-1, or value and max}, Chart{data,series:[{type,dataKey}],xAxis}, Button{label,onClickAction}, Form{onSubmitAction,children}. Fields, each with a name and a short label: Select|RadioGroup{options:[{label,value}]}, DatePicker{min?,max?} (YYYY-MM-DD), TimePicker{min?,max?,step?} (HH:MM, 24-hour), DayPicker (days of the week, sent as \"mon,wed,fri\"), Checkbox, Input, Textarea. A ListView holds ListViewItem{children}; to have the person choose one row, give the ListView a name and each row a value, and confirm sends the pick. Select, RadioGroup and such a list also let the person type their own answer instead; set allowOther:false only when nothing but an option will do. An action is {type,payload?}; {type:\"open_url\",payload:{url}} opens a link. Labels are plain words, no emoji. A press (confirm, cancel, a button) arrives as their next message, even mid-turn; if they type something else instead, that is their answer. Do what does not depend on it, then end your turn; never wait for it. To replace a widget in place (a progress bar moving, a status changing), call this again with the widget_id it returned (was update_widget); one the person already answered cannot be replaced, so show a new one. Keep it small: one confirm, one cancel, at most 8 rows. Never ask for passwords here. Not available in rooms.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        widget: { type: "object", additionalProperties: true, description: "The widget tree." },
        fallback_text: { type: "string", description: "Optional plain-text version for clients that cannot draw widgets. Written for you when omitted." },
        widget_id: { type: "string", description: "Only to replace a widget you showed: the id it returned." },
      },
      required: ["widget"],
    },
  },
];
