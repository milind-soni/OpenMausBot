// The chat-widget tool of the agents catalog: definitions only, sent to the model on every turn.
export const WIDGET_TOOL_DEFINITIONS = [
  {
    name: "show_widget",
    description:
      "Show an interactive widget in this chat: one question answered with a tap instead of typing (a time, a day, one of a few options), a form prefilled (defaultValue) with what they want to change, or a live status. Ask only what you cannot find or sensibly default, one question per widget; a pick-one is a Card with a Row of Buttons, at most six. A yes or no needs none: ask it in your message. Data and results go in a markdown table in your message instead. `widget` is one JSON tree. The root is {type:\"Card\"|\"ListView\", title?, caption?, children:[...], confirm?:{label,action}, cancel?:{label,action}}. Nodes: Row, Col, Box, Spacer, Divider, Text, Title, Caption, Markdown, Badge{label,color}, Icon{name}, Image{src}, Progress{value 0-1}, Chart{data,series:[{type,dataKey}],xAxis}, Button{label,onClickAction}, Form{onSubmitAction,children}. Fields, each with a name and a short label: Select|RadioGroup{options:[{label,value}]}, DatePicker (YYYY-MM-DD), TimePicker (HH:MM), DayPicker, Checkbox, Input, Textarea. A ListView holds ListViewItem{children}; give it a name and each row a value to let the person choose one. An action is {type,payload?}; {type:\"open_url\",payload:{url}} opens a link. Labels are plain words, no emoji. A press arrives as their next message; if they type something else instead, that is their answer. Never wait for it. Call again with its widget_id to replace it in place, until it is answered. At most 8 rows. The whole widget is JSON: keep it under 32000 characters, and one action's payload (a Button's onClickAction, a Form's onSubmitAction, or a Card's confirm action) at most 2000 characters of JSON. Never ask for passwords here. In rooms it is view-only: ask in text there.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        widget: { type: "object", additionalProperties: true },
        fallback_text: { type: "string", description: "Optional plain text for clients without widgets." },
        widget_id: { type: "string", description: "Only to replace a widget you showed." },
      },
      required: ["widget"],
    },
  },
];
