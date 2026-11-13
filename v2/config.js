// Configuração do banco (Supabase) da casa.
// A chave "publishable" é feita para ficar no aplicativo; não é segredo.
window.GPLAN_CONFIG = {
  supabaseUrl: 'https://xnxudiyrumkncyoibefe.supabase.co',
  supabaseKey: 'sb_publishable_1P9zA4LwM9ZzP8cV2LCYeA_B8lMyyFd',
  nomeDaCasa: 'Nossa casa',
  // Chave PÚBLICA dos avisos com o app fechado (a privada fica só nos Secrets do Supabase).
  vapidPublicKey: 'BJAv51d-jWEOuMjNBy27JVwMt9dyqx9dfZmnvk0USMM5FFvol5ppbhOaw-PusN4WNkLkYUYZ_4ABLXQI12kvVcg'
};
