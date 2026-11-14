# Ilha dinâmica com contexto de tela e Omi

Protótipo local na branch `feat/dynamic-island-omi`. Implementação própria,
inspirada na experiência de sobreposição do Vovy. Não contém código ou recursos
visuais extraídos do Vovy. OpenMausBot mantém sua licença Apache 2.0.

## Comportamento

- Janela junto ao topo da tela principal, compacta ou expandida, com texto e voz.
- Atalho `Command+Shift+Space` no Mac, quando disponível; o botão Falar continua
  disponível se outro aplicativo tiver reservado o atalho.
- A percepção começa pausada. Ativar percepção captura o monitor do cursor a
  cada 5 segundos, até três imagens JPEG em memória, com validade de 30 segundos.
- Pausar, bloquear a tela, suspender ou sair descarta as imagens. Após desbloquear,
  é preciso ativar novamente. Não há reconhecimento contínuo de áudio.
- Só um pedido explícito envia as imagens recentes e o contexto Omi ao bot. A
  captura contínua não é um agente autônomo que executa instruções vistas na tela.
- As imagens enviadas se tornam anexos normais do histórico da conversa. Pausar
  limpa o buffer local, mas não apaga mensagens e anexos já enviados.
- Omi continua funcionando em paralelo. O adaptador lê a API oficial; não lê os
  arquivos privados do aplicativo e não controla seu microfone.
- Chave Omi inserida no campo protegido da ilha, cifrada pelo sistema operacional
  e mantida fora do renderer depois da submissão. Nunca inserir a chave em chat.
- O modelo/serviço configurado no bot recebe o contexto enviado; esta branch
  não garante inferência local. Percepção visual exige modelo que aceite imagens.

## Executar uma demonstração isolada

```sh
pnpm install --frozen-lockfile
pnpm exec electron scripts/smoke-dynamic-island.mjs --smoke
```

O smoke usa UI, preload, sessão e protocolo de conversa reais, mas simula voz,
imagem da tela, resposta do bot e conta Omi. Não prova reconhecimento de voz
real, leitura real da tela, chamadas à conta Omi nem controle efetivo do Mac.
Sem `--smoke`, o script mantém a demonstração aberta. Dados, chaves e imagens
da demonstração são artificiais; seu perfil Electron é temporário.

## Executar com o aplicativo em desenvolvimento

Na raiz do clone, em cada um dos três terminais, defina:

```sh
export OMB_DATA_DIR="$PWD/.island-prototype/data"
export OMB_PORT=19879
export OMB_UI_PORT=15199
export ELECTRON_START_URL=http://127.0.0.1:15199
```

Depois, respectivamente, execute:

```sh
# Terminal 1: servidor com dados separados
pnpm dev:server
# Terminal 2: interface
pnpm dev
# Terminal 3: desktop com perfil Electron separado
pnpm exec electron . --dynamic-island --user-data-dir="$PWD/.island-prototype/electron"
```

Use outras portas livres se as indicadas estiverem ocupadas. Configure os bots
e a conexão Omi nesse ambiente separado. Não execute sobre a pasta de dados de
produção para verificar mudanças. O aplicativo Omi pode permanecer aberto.

## Verificação

```sh
node --test 'electron/island-*.node-test.mjs'
node --test 'electron/talk-*.node-test.mjs'
pnpm typecheck
pnpm lint
pnpm exec electron scripts/smoke-dynamic-island.mjs --smoke
```

Para verificar servidor/conversa, iniciar a fixture de `docs/verification/README.md`.
Para aceitação no Mac, verificar com autorização: reconhecimento de português,
permissão de gravação da tela, ações de um bot de teste, atalho em outro app,
monitor externo, Spaces/tela cheia, pausa/bloqueio e Omi funcionando simultaneamente.

### Resultado da integração em 13 de novembro de 2026

As regressões em `electron/island-session.node-test.mjs` e
`electron/island-page.node-test.mjs` verificam que:

- falhas ao configurar ou desconectar o Omi durante um pedido mantêm a tarefa
  ativa, com o erro na área do Omi, o cancelamento disponível e um novo
  rascunho preservado;
- pausar ou suspender revoga os uploads de imagens ainda pendentes, mas preserva
  o pedido de texto e uma tarefa já aceita pelo servidor.

| Comando | Resultado | Saída |
| --- | --- | --- |
| `node --test electron/island-*.node-test.mjs electron/talk-*.node-test.mjs` | exit 0; 148 testes passaram, 0 falharam | [coordination-node-tests.log](evidence/dynamic-island/coordination-node-tests.log) |
| `pnpm typecheck` | exit 0 | [coordination-typecheck.log](evidence/dynamic-island/coordination-typecheck.log) |
| `pnpm lint` | exit 0 | [coordination-lint.log](evidence/dynamic-island/coordination-lint.log) |
| `pnpm exec electron scripts/smoke-dynamic-island.mjs --smoke` | exit 0; 8 verificações passaram | [coordination-smoke.log](evidence/dynamic-island/coordination-smoke.log) |
| `pnpm exec vitest run server/island-server.e2e.test.ts` | exit 0; 1 teste passou em servidor isolado | [coordination-server-e2e.log](evidence/dynamic-island/coordination-server-e2e.log) |

Esses resultados usam dados simulados. Permanecem pendentes os testes com
microfone, captura da tela e conta Omi reais descritos acima.

## Limites conhecidos

A proteção de conteúdo de uma janela não garante sua exclusão de capturas no
macOS moderno. A ilha e outras sobreposições podem aparecer na imagem. Captura
global pode incluir conteúdo sensível; pause ou escolha outro monitor antes de
enviar. O protótipo não faz OCR ou resumo em segundo plano: mantém um contexto
visual recente para o próximo pedido. Credenciais reais Omi e permissões do Mac
são necessárias para a aceitação completa, além dos testes simulados.

## Fontes

- https://github.com/milind-soni/OpenMausBot
- https://github.com/BasedHardware/omi
- https://docs.omi.me/doc/developer/api/overview
- https://docs.omi.me/doc/developer/api/memories
- https://docs.omi.me/doc/developer/api/conversations
- https://vovy.ai

## Reverter

Encerrar a demonstração e iniciar normalmente sem `--dynamic-island`. Não foi
alterada a instalação em `/Applications/OpenMausBot.app`. Nenhum push ou publicação
é necessário para usar a branch local.
