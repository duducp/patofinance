export function findHelp(input: string): string | null {
  const key = input.replace(/^\//, "").toLowerCase();
  for (const entry of Object.values(COMMAND_HELP)) {
    if (entry.keys.includes(key)) return entry.text;
  }
  return null;
}

const COMMAND_HELP: Record<string, { keys: string[]; text: string }> = {
  despesa: {
    keys: ["despesa"],
    text:
      `📖 *Ajuda — /despesa*\n\n` +
      `Registra uma despesa.\n\n` +
      `*Como usar:*\n` +
      `\`/despesa 50 mercado\`\n` +
      `\`/despesa 100 vestuário --grupo Nubank\`\n` +
      `\`/despesa 200 mercado --data 15/01/2024 --tags #feira\`\n\n` +
      `*Flags:*\n` +
      `\`--grupo Nome\` — vincular a um grupo\n` +
      `\`--data DD/MM/AAAA\` — data personalizada\n` +
      `\`#tag\` — adicionar tags\n\n` +
      `*Comandos relacionados:*\n` +
      `/receita — Registrar receita\n` +
      `/categoria — Gerenciar categorias\n` +
      `/grupo — Gerenciar grupos`,
  },
  receita: {
    keys: ["receita"],
    text:
      `📖 *Ajuda — /receita*\n\n` +
      `Registra uma receita (entrada de dinheiro).\n\n` +
      `*Como usar:*\n` +
      `\`/receita 3000 salário\`\n` +
      `\`/receita 1500 freela\`\n` +
      `\`/receita 5000 --grupo Nubank\`\n\n` +
      `*Flags:*\n` +
      `\`--grupo Nome\` — vincular a um grupo\n` +
      `\`--data DD/MM/AAAA\` — data personalizada\n` +
      `\`#tag\` — adicionar tags\n\n` +
      `*Comandos relacionados:*\n` +
      `/despesa — Registrar despesa\n` +
      `/saldo — Ver saldo`,
  },
  saldo: {
    keys: ["saldo"],
    text:
      `📖 *Ajuda — /saldo*\n\n` +
      `Mostra o saldo do período (receitas - despesas).\n\n` +
      `*Como usar:*\n` +
      `\`/saldo\` — saldo deste mês\n` +
      `\`/saldo mes passado\` — saldo do mês anterior\n` +
      `\`/saldo janeiro\` — saldo de janeiro\n` +
      `\`/saldo --grupo Pessoal\` — saldo de um grupo específico\n\n` +
      `*Comandos relacionados:*\n` +
      `/extrato — Extrato detalhado\n` +
      `/resumo — Resumo por categoria`,
  },
  extrato: {
    keys: ["extrato"],
    text:
      `📖 *Ajuda — /extrato*\n\n` +
      `Mostra o extrato de transações com painel de filtros interativo.\n\n` +
      `*Como usar:*\n` +
      `\`/extrato\` — extrato deste mês\n` +
      `\`/extrato mes passado\` — extrato do mês anterior\n` +
      `\`/extrato janeiro 2025\` — extrato de janeiro\n` +
      `\`/extrato --grupo Pessoal\` — filtrar por grupo\n\n` +
      `*Filtros disponíveis:* categoria, grupo, tags, tipo (receita/despesa), período, status\n\n` +
      `*Comandos relacionados:*\n` +
      `/saldo — Ver saldo\n` +
      `/resumo — Resumo por categoria`,
  },
  resumo: {
    keys: ["resumo"],
    text:
      `📖 *Ajuda — /resumo*\n\n` +
      `Mostra um resumo de receitas e despesas agrupado por categoria.\n\n` +
      `*Como usar:*\n` +
      `\`/resumo\` — resumo deste mês\n` +
      `\`/resumo ultimo mes\` — resumo do mês anterior\n` +
      `\`/resumo --grupo Trabalho\` — resumo de um grupo específico\n\n` +
      `*Comandos relacionados:*\n` +
      `/extrato — Extrato detalhado\n` +
      `/saldo — Ver saldo`,
  },
  detalhes: {
    keys: ["detalhes"],
    text:
      `📖 *Ajuda — /detalhes*\n\n` +
      `Exibe os detalhes de uma transação com opções de edição e exclusão.\n\n` +
      `*Como usar:*\n` +
      `\`/detalhes 42\` — ver detalhes da transação #42\n\n` +
      `*Ações disponíveis:*\n` +
      `• Editar valor, descrição, data, categoria, grupo ou tags\n` +
      `• Excluir a transação (com confirmação)\n\n` +
      `*Comandos relacionados:*\n` +
      `/extrato — Listar transações\n` +
      `/despesa — Registrar despesa\n` +
      `/receita — Registrar receita`,
  },
  categoria: {
    keys: ["categoria", "categorias"],
    text:
      `📖 *Ajuda — /categoria*\n\n` +
      `Gerencia as categorias (alimentação, transporte, etc.).\n\n` +
      `*Como usar:*\n` +
      `\`/categoria\` — lista todas as categorias com botões\n` +
      `\`/categoria Transporte\` — cria uma nova categoria\n\n` +
      `*Comandos relacionados:*\n` +
      `/grupo — Gerenciar grupos\n` +
      `/tag — Gerenciar tags`,
  },
  grupo: {
    keys: ["grupo", "grupos"],
    text:
      `📖 *Ajuda — /grupo*\n\n` +
      `Gerencia os grupos (contas bancárias, carteiras, etc.).\n\n` +
      `*Como usar:*\n` +
      `\`/grupo\` — lista todos os grupos com botões\n` +
      `\`/grupo Nubank\` — cria um novo grupo\n\n` +
      `*Comandos relacionados:*\n` +
      `/categoria — Gerenciar categorias\n` +
      `/tag — Gerenciar tags`,
  },
  tag: {
    keys: ["tag", "tags"],
    text:
      `📖 *Ajuda — /tag*\n\n` +
      `Lista todas as tags usadas com contagem de transações.\n\n` +
      `*Como usar:*\n` +
      `\`/tag\` — lista todas as tags com botões clicáveis\n\n` +
      `💡 Tags são adicionadas automaticamente ao usar \`#tag\` nas transações.\n\n` +
      `*Comandos relacionados:*\n` +
      `/categoria — Gerenciar categorias\n` +
      `/grupo — Gerenciar grupos`,
  },
  limpar: {
    keys: ["limpar"],
    text:
      `📖 *Ajuda — /limpar*\n\n` +
      `Remove categorias e grupos que não possuem transações vinculadas.\n\n` +
      `*Como usar:*\n` +
      `\`/limpar\` — mostra quantas categorias/grupos serão removidos e pede confirmação\n\n` +
      `*Comandos relacionados:*\n` +
      `/resetar — Resetar conta completamente`,
  },
  resetar: {
    keys: ["resetar"],
    text:
      `📖 *Ajuda — /resetar*\n\n` +
      `Reseta completamente sua conta, apagando todas as transações, categorias, grupos e tags.\n\n` +
      `⚠️ *Essa ação não pode ser desfeita!*\n\n` +
      `*Como usar:*\n` +
      `\`/resetar\` — inicia o processo de confirmação. Digite \`RESETAR\` para confirmar\n\n` +
      `*Comandos relacionados:*\n` +
      `/limpar — Remove apenas itens sem uso`,
  },
  cancelar: {
    keys: ["cancelar"],
    text:
      `📖 *Ajuda — /cancelar*\n\n` +
      `Cancela uma operação em andamento (wizard).\n\n` +
      `*Como usar:*\n` +
      `\`/cancelar\` — cancela o wizard atual\n\n` +
      `💡 Use quando estiver no meio de um registro e quiser sair.`,
  },
};
