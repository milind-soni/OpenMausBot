/** What clients draw the setup card under a new bot's greeting from. */
export interface SetupCardFields {
  /** A new bot's greeting while it has no role or instructions: clients that know it draw the setup card under the
   * text; `text` reads on its own for older ones. It stays once the card is answered, so the card can show the answer;
   * closing the card clears it. */
  setupOffer?: true;
  /** The setup card's answers, in the app's language. Picking one sends its words; absent on older greetings, where a
   * client offers its own. Replaced only in the change that clears setupChoicesPending or setupChoicesUpdating. */
  setupChoices?: string[];
  /** Personal answers for this card are being written: clients show the card without answers until it clears. The
   * server clears it within 6 s, in the same change that sets setupChoices if they came in time; a client still seeing
   * it 8 s after showing the card, or on a greeting older than 20 s, shows setupChoices. */
  setupChoicesPending?: true;
  /** Epoch ms the bot's latest rename started rewriting setupChoices, while the card was unanswered: clients keep
   * showing them but take no pick until it clears. The server clears it within 7 s of the stamp, in the same change
   * that sets the new setupChoices if they came in time; a client still seeing a stamp 8 s after it first saw it, or
   * one older than 20 s, takes picks again. */
  setupChoicesUpdating?: number;
}
