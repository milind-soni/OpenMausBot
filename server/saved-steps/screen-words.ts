/** Words another app shows in the person's own language, for each language this app ships its interface in. A word
 * names a whole word or phrase; `word*` also matches longer words that start with it; `=word` matches only a label that
 * is exactly that. Languages written without spaces match anywhere in the label. */
export interface LanguageWords { words: readonly string[]; unspaced?: true }

/** Security invariant: steps that press one of these (send, delete, buy, pay, post, submit, order, transfer, publish and
 * their like) are never saved, so that request always goes to the AI. */
export const FINAL_ACTIONS: Readonly<Record<string, LanguageWords>> = {
  en: { words: ["send", "resend", "paperplane", "delete", "trash", "erase", "remove", "discard", "empty bin", "move to bin", "don't save", "do not save",
    "buy", "purchase", "checkout", "check out", "subscribe", "unsubscribe", "pay", "place order", "place your order", "order now", "book now", "reserve", "donate",
    "post", "publish", "tweet", "share", "reply", "comment", "submit", "confirm", "transfer", "withdraw", "upload", "approve", "uninstall", "reset", "shut down", "restart"] },
  de: { words: ["senden", "absenden", "abschicken", "versenden", "löschen", "entfernen", "verwerfen", "papierkorb entleeren", "in den papierkorb", "nicht sichern",
    "nicht speichern", "kaufen", "kauf", "erwerben", "bestellen", "bestellung aufgeben", "zur kasse", "abonnieren", "abbestellen", "bezahlen", "zahlen", "buchen",
    "reservieren", "spenden", "posten", "veröffentlichen", "teilen", "antworten", "kommentieren", "einreichen", "übermitteln", "bestätigen", "überweisen",
    "überweisung", "abheben", "hochladen", "genehmigen", "deinstallieren", "zurücksetzen", "ausschalten", "neu starten"] },
  es: { words: ["enviar", "envía", "envia", "reenviar", "eliminar", "elimina", "borrar", "borra", "suprimir", "quitar", "descartar", "vaciar papelera",
    "vaciar la papelera", "trasladar a la papelera", "mover a la papelera", "no guardar", "comprar", "compra", "finalizar compra", "realizar pedido", "hacer pedido",
    "tramitar pedido", "pedir", "suscribirse", "suscribir", "cancelar suscripción", "darse de baja", "pagar", "paga", "reservar", "donar", "publicar", "publica",
    "compartir", "comparte", "responder", "responde", "comentar", "confirmar", "confirma", "transferir", "retirar", "subir", "aprobar", "desinstalar", "restablecer",
    "apagar", "reiniciar"] },
  fr: { words: ["envoyer", "renvoyer", "supprimer", "effacer", "retirer", "enlever", "rejeter", "vider la corbeille", "placer dans la corbeille",
    "mettre à la corbeille", "ne pas enregistrer", "acheter", "passer la commande", "passer commande", "commander", "payer", "réserver", "faire un don", "abonner",
    "désabonner", "publier", "poster", "partager", "répondre", "commenter", "soumettre", "valider", "confirmer", "transférer", "virement", "téléverser", "approuver",
    "désinstaller", "réinitialiser", "éteindre", "redémarrer"] },
  it: { words: ["invia", "inviare", "elimina", "eliminare", "cancella", "cancellare", "rimuovi", "rimuovere", "scarta", "svuota il cestino", "svuota cestino",
    "sposta nel cestino", "non salvare", "acquista", "acquistare", "compra", "comprare", "effettua l'ordine", "effettua ordine", "ordina ora", "paga", "pagare",
    "prenota", "dona", "abbonati", "iscriviti", "annulla iscrizione", "disiscriviti", "pubblica", "pubblicare", "condividi", "rispondi", "commenta", "conferma",
    "confermare", "trasferisci", "bonifico", "preleva", "carica", "approva", "disinstalla", "ripristina", "spegni", "riavvia"] },
  "pt-br": { words: ["enviar", "envie", "reenviar", "excluir", "exclua", "apagar", "apague", "deletar", "remover", "descartar", "esvaziar lixo",
    "esvaziar a lixeira", "mover para o lixo", "mover para a lixeira", "não salvar", "comprar", "compre", "finalizar compra", "fazer pedido", "finalizar pedido",
    "pagar", "pague", "reservar", "doar", "assinar", "cancelar assinatura", "publicar", "publique", "postar", "compartilhar", "compartilhe", "responder", "comentar",
    "confirmar", "confirme", "transferir", "sacar", "carregar", "fazer upload", "aprovar", "desinstalar", "redefinir", "desligar", "reiniciar"] },
  pl: { words: ["wyślij", "wysłać", "usuń", "usunąć", "wymaż", "skasuj", "odrzuć", "opróżnij kosz", "przenieś do kosza", "nie zachowuj", "nie zapisuj", "kup",
    "kupić", "zamów", "zamówić", "złóż zamówienie", "zapłać", "zapłacić", "zarezerwuj", "przekaż darowiznę", "subskrybuj", "anuluj subskrypcję", "opublikuj",
    "opublikować", "publikuj", "udostępnij", "odpowiedz", "skomentuj", "komentuj", "prześlij", "przesłać", "zatwierdź", "potwierdź", "przelej", "przelew", "wypłać",
    "odinstaluj", "resetuj", "zresetuj", "wyłącz", "uruchom ponownie"] },
  ru: { words: ["отправить", "переотправить", "удалить", "стереть", "убрать", "очистить корзину", "переместить в корзину", "не сохранять", "купить",
    "оформить заказ", "заказать", "оплатить", "забронировать", "пожертвовать", "подписаться", "отписаться", "опубликовать", "поделиться", "ответить",
    "комментировать", "прокомментировать", "подтвердить", "перевести", "вывести", "загрузить", "одобрить", "сбросить", "выключить", "перезагрузить"] },
  uk: { words: ["надіслати", "відправити", "видалити", "стерти", "вилучити", "прибрати", "очистити кошик", "перемістити в кошик", "перенести в кошик",
    "не зберігати", "купити", "оформити замовлення", "замовити", "оплатити", "сплатити", "забронювати", "пожертвувати", "підписатися", "відписатися",
    "опублікувати", "поділитися", "відповісти", "коментувати", "прокоментувати", "подати", "підтвердити", "переказати", "переказ", "вивести", "завантажити",
    "схвалити", "скинути", "вимкнути", "перезавантажити"] },
  tr: { words: ["gönder", "sil", "kaldır", "çöp sepetini boşalt", "çöp kutusunu boşalt", "çöp sepetine taşı", "çöp sepetine at", "kaydetme", "satın al",
    "sipariş ver", "siparişi tamamla", "öde", "ödeme yap", "rezervasyon yap", "bağış yap", "abone ol", "abonelikten çık", "yayınla", "paylaş", "yanıtla", "cevapla",
    "yorum yap", "onayla", "aktar", "para çek", "yükle", "sıfırla", "yeniden başlat", "bilgisayarı kapat"] },
  vi: { words: ["gửi", "xóa", "xoá", "gỡ bỏ", "loại bỏ", "dọn sạch thùng rác", "làm rỗng thùng rác", "chuyển vào thùng rác", "đưa vào thùng rác", "không lưu",
    "mua", "đặt hàng", "thanh toán", "trả tiền", "đặt chỗ", "đặt phòng", "quyên góp", "đăng ký", "hủy đăng ký", "huỷ đăng ký", "=đăng", "đăng bài", "đăng tin",
    "xuất bản", "chia sẻ", "trả lời", "bình luận", "nộp", "xác nhận", "chuyển tiền", "chuyển khoản", "rút tiền", "tải lên", "phê duyệt", "gỡ cài đặt", "đặt lại",
    "tắt máy", "khởi động lại"] },
  hi: { words: ["भेज*", "हटा*", "मिटा*", "डिलीट*", "खरीद*", "भुगतान*", "प्रकाशित*", "सबमिट*", "पुष्टि*", "अपलोड*", "रीसेट*", "ऑर्डर*", "अनइंस्टॉल*", "ट्रांसफ़र*",
    "ट्रांसफर*", "स्थानांतरित*", "रीस्टार्ट*", "स्वीकृत*", "अनुमोदित*", "साझा करें", "शेयर करें", "जवाब दें", "उत्तर दें", "टिप्पणी करें", "जमा करें", "पोस्ट करें",
    "सदस्यता लें", "सदस्यता रद्द", "निकालें", "शट डाउन", "पुनः आरंभ", "बुक करें", "दान करें", "सहेजें नहीं", "न सहेजें", "खाली करें"] },
  ko: { unspaced: true, words: ["보내기", "전송", "송신", "삭제", "제거", "지우기", "버리기", "폐기", "휴지통", "저장 안 함", "저장하지 않음", "구매", "구입", "결제",
    "지불", "주문", "구독", "예약", "기부", "후원", "게시", "등록", "올리기", "발행", "공개", "공유", "답장", "답글", "댓글", "제출", "확정", "송금", "이체", "출금",
    "업로드", "승인", "재설정", "초기화", "시스템 종료", "다시 시작", "재시동", "탈퇴", "전달"] },
  ja: { unspaced: true, words: ["送信", "削除", "消去", "取り除", "除去", "破棄", "ゴミ箱を空", "ゴミ箱に入れる", "ゴミ箱へ移動", "保存しない", "購入", "買う", "注文", "支払",
    "決済", "予約", "寄付", "購読", "申し込", "申込", "投稿", "公開", "共有", "返信", "コメント", "提出", "確定", "確認", "振込", "振り込", "送金", "出金", "引き出",
    "アップロード", "承認", "アンインストール", "リセット", "初期化", "シャットダウン", "再起動", "転送"] },
  zh: { unspaced: true, words: ["发送", "删除", "抹掉", "移除", "清除", "丢弃", "放弃", "清倒废纸篓", "清空废纸篓", "清空回收站", "移到废纸篓", "不存储", "不保存", "购买",
    "结算", "结账", "下单", "支付", "付款", "预订", "预约", "捐款", "捐赠", "订阅", "退订", "发布", "发表", "分享", "共享", "回复", "评论", "提交", "确认", "转账",
    "转帐", "汇款", "提现", "上传", "批准", "卸载", "重置", "关机", "重新启动", "重启", "转发"] },
  "zh-tw": { unspaced: true, words: ["傳送", "發送", "送出", "刪除", "清除", "移除", "丟棄", "放棄", "清空垃圾桶", "丟到垃圾桶", "移到垃圾桶", "不要儲存", "不儲存",
    "購買", "結帳", "下單", "付款", "支付", "預訂", "預約", "捐款", "捐贈", "訂閱", "發佈", "發布", "發表", "張貼", "分享", "共享", "回覆", "留言", "評論", "提交",
    "確認", "轉帳", "匯款", "提款", "上傳", "核准", "批准", "解除安裝", "重置", "重設", "關機", "重新開機", "重新啟動", "轉寄"] },
};

/** Security invariant: a field labelled with one of these holds a secret, and a step on it is never saved. */
export const SECRET_FIELDS: Readonly<Record<string, LanguageWords>> = {
  en: { words: ["password", "passcode", "passphrase", "pin", "pin code", "security code", "verification code", "one-time code", "otp", "cvv", "cvc",
    "card number", "credit card", "api key", "secret", "private key", "recovery key", "recovery phrase", "seed phrase", "social security"] },
  de: { words: ["passwort", "kennwort", "pin-code", "geheimzahl", "sicherheitscode", "bestätigungscode", "einmalcode", "kartennummer", "kreditkarte",
    "api-schlüssel", "geheim"] },
  es: { words: ["contraseña", "clave", "código de seguridad", "código de verificación", "número de tarjeta", "tarjeta de crédito"] },
  fr: { words: ["mot de passe", "code pin", "code secret", "code de sécurité", "code de vérification", "numéro de carte", "carte de crédit", "cryptogramme"] },
  it: { words: ["codice pin", "codice di sicurezza", "codice di verifica", "numero della carta", "numero di carta", "carta di credito"] },
  "pt-br": { words: ["senha", "código de segurança", "código de verificação", "número do cartão", "cartão de crédito"] },
  pl: { words: ["hasło", "kod pin", "kod bezpieczeństwa", "kod weryfikacyjny", "numer karty", "karta kredytowa"] },
  ru: { words: ["пароль", "пин", "пин-код", "код безопасности", "код подтверждения", "номер карты"] },
  uk: { words: ["пароль", "пін", "пін-код", "код безпеки", "код підтвердження", "номер картки"] },
  tr: { words: ["şifre", "parola", "güvenlik kodu", "doğrulama kodu", "kart numarası", "kredi kartı"] },
  vi: { words: ["mật khẩu", "mã pin", "mã bảo mật", "mã xác minh", "mã xác thực", "số thẻ", "thẻ tín dụng"] },
  hi: { words: ["पासवर्ड", "पिन", "सुरक्षा कोड", "सत्यापन कोड", "कार्ड नंबर", "कार्ड संख्या"] },
  ko: { unspaced: true, words: ["비밀번호", "암호", "비밀", "핀 번호", "보안 코드", "인증 코드", "인증번호", "확인 코드", "카드 번호", "카드번호", "신용카드"] },
  ja: { unspaced: true, words: ["パスワード", "パスコード", "暗証番号", "pinコード", "セキュリティコード", "認証コード", "確認コード", "カード番号", "クレジットカード"] },
  zh: { unspaced: true, words: ["密码", "口令", "安全码", "验证码", "卡号", "信用卡"] },
  "zh-tw": { unspaced: true, words: ["密碼", "安全碼", "驗證碼", "卡號", "信用卡"] },
};

const QUOTES = /[‘’ʼ`´]/g;

/** Case, Unicode forms, Turkish dots, curly apostrophes, dashes and spacing evened out, the same way for words and labels. */
function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/̇/g, "").replace(/ı/g, "i").replace(QUOTES, "'").replace(/\p{Pd}/gu, "-").replace(/\s+/g, " ").trim();
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EDGE = String.raw`[\p{L}\p{M}\p{N}]`;

function matcher(table: Readonly<Record<string, LanguageWords>>): (text: string | undefined) => boolean {
  const exact = new Set<string>();
  const whole: string[] = [];
  const starts: string[] = [];
  const inside: string[] = [];
  for (const { words, unspaced } of Object.values(table)) {
    for (const word of words) {
      if (word.startsWith("=")) exact.add(fold(word.slice(1)));
      else if (unspaced) inside.push(escaped(fold(word)));
      else if (word.endsWith("*")) starts.push(escaped(fold(word.slice(0, -1))));
      else whole.push(escaped(fold(word)));
    }
  }
  const pattern = new RegExp([
    whole.length ? `(?<!${EDGE})(?:${whole.join("|")})(?!${EDGE})` : "",
    starts.length ? `(?<!${EDGE})(?:${starts.join("|")})` : "",
    inside.length ? `(?:${inside.join("|")})` : "",
  ].filter(Boolean).join("|") || "(?!)", "u");
  return (text) => {
    if (!text) return false;
    const folded = fold(text);
    return exact.has(folded) || pattern.test(folded);
  };
}

/** True when a label or title names a final, can't-undo action in any language this app ships. */
export const namesFinalAction = matcher(FINAL_ACTIONS);

/** True when a field's label says it holds a password, PIN, code or card number in any language this app ships. */
export const namesSecret = matcher(SECRET_FIELDS);
