/* Настройки мини-приложения. Здесь НЕТ секретов: публичный ключ нужен только для проверки кодов. */
window.APP_CONFIG = {
  // Имя вашего бота без @ (например "MyExamBot")
  BOT_USERNAME: "Duckshool_bot",
  // Публичный ключ: впишется сам после  python bot/keygen.py
  PUBLIC_KEY: "8ANIAlxQ5gbd9whZCsvecq7Pznlyu1iMlWFwdhVJkYA",
  // Цены только для показа на экране. Настоящую цену определяет бот (bot/.env).
  PRICES: { premium: 150, premiumRegular: 200, subject: 25, career: 15 },
  PREMIUM_DAYS: 30
};
