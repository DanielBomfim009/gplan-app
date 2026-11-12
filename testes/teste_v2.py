"""Testes da versão 2 do Controle Financeiro com um Supabase FALSO.

Roda um servidor local da pasta do repositório, abre a página v2 no Chromium
(Playwright) trocando a biblioteca do Supabase pelo mock_supabase.js e confere,
de ponta a ponta, as funções principais: entrar, lançar, pagar, editar,
excluir, recorrência, metas, contas, orçamento, importação da versão antiga,
fila sem internet e tempo real entre duas abas (duas pessoas).

Uso:  python testes/teste_v2.py
Nada aqui fala com a internet nem com banco real.
"""
import http.server
import json
import os
import socketserver
import sys
import threading
import time
from datetime import date
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

RAIZ = Path(__file__).resolve().parents[1]
PORTA = 8765
BASE = f"http://127.0.0.1:{PORTA}/v2/index.html"
MOCK_JS = (RAIZ / "testes" / "mock_supabase.js").read_text(encoding="utf-8")
CONFIG_JS = "window.GPLAN_CONFIG = { supabaseUrl: 'https://mock.supabase.co', supabaseKey: 'mock', nomeDaCasa: 'Casa Teste' };"
CASA = "00000000-0000-0000-0000-000000000001"

falhas = []
erros_console = []


def servidor():
    class Quieto(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = lambda *a, **k: Quieto(*a, directory=str(RAIZ), **k)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORTA), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def rotear(page):
    page.route("**/cdn.jsdelivr.net/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=MOCK_JS))
    page.route("**/cdn.tailwindcss.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body="window.tailwind=window.tailwind||{};"))
    page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, content_type="text/css", body=""))
    page.route("**/config.js", lambda r: r.fulfill(status=200, content_type="application/javascript", body=CONFIG_JS))
    page.on("pageerror", lambda e: erros_console.append(f"pageerror: {e}"))
    page.on("console", lambda m: erros_console.append(f"console.{m.type}: {m.text}") if m.type == "error" and "Failed to load resource" not in m.text else None)


def txt(page, seletor):
    """Texto do elemento com o espaço especial do R$ trocado por espaço comum."""
    return (page.text_content(seletor) or "").replace(" ", " ")


def checar(cond, msg):
    if cond:
        print(f"  OK   {msg}")
    else:
        print(f"  FALHA {msg}")
        falhas.append(msg)


def db(page):
    return page.evaluate("JSON.parse(localStorage.getItem('mock-db') || 'null')")


def entrar(page, email, senha="123456"):
    page.goto(BASE)
    page.wait_for_selector("#auth-shell:not(.hidden)", timeout=10000)
    page.fill("#auth-email", email)
    page.fill("#auth-password", senha)
    page.click("#auth-submit-btn")
    page.wait_for_selector("#app:not(.hidden)", timeout=10000)
    page.wait_for_function("document.getElementById('live-indicator').classList.contains('ok')", timeout=10000)


def abrir_modal_tx(page):
    page.click("#fab")
    page.wait_for_selector("#modal-tx.active")


def lancar(page, valor, descricao, tipo="expense", status="pending", categoria=None, recorrente=False, vencimento=None, pagamento=None):
    abrir_modal_tx(page)
    page.click("#btn-expense" if tipo == "expense" else "#btn-income")
    page.fill("#tx-amount", "")
    page.type("#tx-amount", valor)
    page.fill("#tx-desc", descricao)
    page.select_option("#tx-category", categoria or ("food" if tipo == "expense" else "salary"))
    if vencimento:
        page.fill("#tx-date", vencimento)
    if pagamento:
        page.fill("#tx-pay-date", pagamento)
    page.click("#btn-status-pending" if status == "pending" else "#btn-status-paid")
    if recorrente:
        page.click("#recurring-toggle")
    page.click("#form-tx button[type=submit]")
    try:
        page.wait_for_function("!document.getElementById('modal-tx').classList.contains('active')", timeout=8000)
    except Exception:
        diag = page.evaluate("""() => ({
            amount: document.getElementById('tx-amount').value,
            desc: document.getElementById('tx-desc').value,
            cat: document.getElementById('tx-category').value,
            conta: document.getElementById('tx-account').value,
            toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent),
            txs: State.transactions.length,
            fila: queue.length,
            ativo: document.activeElement && document.activeElement.id
        })""")
        print("  DIAGNOSTICO lancar:", json.dumps(diag, ensure_ascii=False))
        page.screenshot(path=str(RAIZ / "testes" / "falha_lancar.png"))
        raise


def esperar_fila_vazia(page):
    page.wait_for_function("document.getElementById('settings-queue-count').textContent === '0'", timeout=10000)


def main():
    httpd = servidor()
    hoje = date.today().isoformat()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 420, "height": 860}, locale="pt-BR", timezone_id="America/Recife", service_workers="block")
        page = ctx.new_page()
        rotear(page)

        print("\n== 1. Entrar e carregar a casa")
        page.goto(BASE)
        page.evaluate("localStorage.clear(); sessionStorage.clear();")
        entrar(page, "daniel@teste.com")
        checar(page.evaluate("State.members.length") == 3 and page.evaluate("document.getElementById('live-indicator').classList.contains('ok')"), "tempo real ligado e 3 membros carregados")
        checar(txt(page, "#sidebar-casa-name").strip() == "Casa Teste", "nome da casa na barra lateral")
        page.click("#bottom-nav .nav-item[data-page='dashboard']")

        print("\n== 2. Data do novo lançamento é a data LOCAL de hoje")
        abrir_modal_tx(page)
        checar(page.input_value("#tx-date") == hoje, f"campo data = {hoje}")
        page.click("#modal-tx .modal-title-row button")
        page.wait_for_function("!document.getElementById('modal-tx').classList.contains('active')")

        print("\n== 3. Lançar despesa pendente e conferir tela + banco")
        lancar(page, "18640", "Mercado")
        esperar_fila_vazia(page)
        d = db(page)
        rows = [r for r in d["lancamentos"] if r["description"] == "Mercado"]
        checar(len(rows) == 1, "uma linha 'Mercado' no banco")
        r = rows[0]
        checar(abs(r["amount"] - 186.40) < 0.001 and r["casa_id"] == CASA and r["created_by"] == "u1" and r["status"] == "pending" and r["date"] == hoje, "linha com valor, casa, autor, status e data certos")
        checar("R$ 186,40" in txt(page, "#dash-expense"), "painel mostra despesa R$ 186,40")
        checar("1 conta vencendo" in txt(page, "#due-alerts-title"), "aviso de conta vencendo hoje")

        print("\n== 4. Marcar como pago pelo Controle")
        page.click("#bottom-nav .nav-item[data-page='control']")
        page.click("[data-control-tab='expense']")
        page.click("#control-expense-list .toggle-status-btn")
        esperar_fila_vazia(page)
        d = db(page)
        checar(d["lancamentos"][0]["status"] == "paid", "status virou 'paid' no banco")
        checar("Pago" in txt(page, "#control-expense-list .toggle-status-btn"), "botão mostra 'Pago'")

        print("\n== 5. Editar valor e descrição")
        page.click("#control-expense-list .tx-item")
        page.wait_for_selector("#modal-tx.active")
        page.fill("#tx-amount", "")
        page.type("#tx-amount", "20000")
        page.fill("#tx-desc", "Mercado do mês")
        page.click("#form-tx button[type=submit]")
        esperar_fila_vazia(page)
        d = db(page)
        checar(len(d["lancamentos"]) == 1 and abs(d["lancamentos"][0]["amount"] - 200.0) < 0.001 and d["lancamentos"][0]["description"] == "Mercado do mês", "edição gravou sem duplicar")

        print("\n== 6. Receita recebida e saldo")
        lancar(page, "500000", "Salário", tipo="income", status="paid")
        esperar_fila_vazia(page)
        page.click("#bottom-nav .nav-item[data-page='dashboard']")
        checar("R$ 5.000,00" in txt(page, "#dash-income"), "painel mostra receita R$ 5.000,00")
        checar("R$ 4.800,00" in txt(page, "#dash-balance"), "saldo do período R$ 4.800,00")
        checar("R$ 4.800,00" in txt(page, "#health-real-balance"), "saldo real (pagos e recebidos) R$ 4.800,00")

        print("\n== 7. Recorrência: 12 linhas, depois excluir toda a série")
        lancar(page, "12000", "Internet", recorrente=True)
        esperar_fila_vazia(page)
        d = db(page)
        serie = [r for r in d["lancamentos"] if r["description"] == "Internet"]
        checar(len(serie) == 12, f"12 lançamentos recorrentes criados ({len(serie)})")
        checar(len({r["recurring_id"] for r in serie}) == 1 and all(r["recurring"] for r in serie), "todos com o mesmo código de recorrência")
        meses = sorted(r["date"][:7] for r in serie)
        checar(len(set(meses)) == 12, "um por mês, em 12 meses diferentes")
        page.click("#bottom-nav .nav-item[data-page='transactions']")
        page.wait_for_selector("#tx-list .tx-item")
        page.click("#tx-list .tx-item:has-text('Internet') button")
        page.wait_for_selector("#modal-tx.active")
        page.click("#delete-tx-btn")
        page.wait_for_selector("#modal-delete-recurring.active")
        page.click("#modal-delete-recurring .delete-option-btn.all")
        esperar_fila_vazia(page)
        d = db(page)
        checar(not [r for r in d["lancamentos"] if r["description"] == "Internet"], "série excluída do banco")
        checar(len(d["lancamentos"]) == 2, "sobraram os 2 lançamentos normais")

        print("\n== 8. Excluir um lançamento simples")
        page.click("#tx-list .tx-item:has-text('Salário') button")
        page.wait_for_selector("#modal-tx.active")
        page.click("#delete-tx-btn")
        esperar_fila_vazia(page)
        d = db(page)
        checar(len(d["lancamentos"]) == 1 and d["lancamentos"][0]["description"] == "Mercado do mês", "só 'Mercado do mês' restou")

        print("\n== 9. Metas: criar, aportar, arquivar, excluir com confirmação")
        page.click("#sidebar-overlay", force=True) if page.is_visible("#sidebar.active") else None
        page.evaluate("openPage('goals')")
        page.click("#page-goals .page-header button.bg-brand\\/15")
        page.wait_for_selector("#modal-goal.active")
        page.fill("#goal-title", "Viagem")
        page.type("#goal-target", "300000")
        page.type("#goal-current", "50000")
        page.click("#modal-goal button[type=submit]")
        esperar_fila_vazia(page)
        d = db(page)
        checar(len(d["metas"]) == 1 and abs(d["metas"][0]["target"] - 3000) < 0.001 and abs(d["metas"][0]["current"] - 500) < 0.001, "meta gravada com 3.000 / 500")
        page.click("#goals-list .goal-add-btn")
        page.wait_for_selector("#modal-goal-add.active")
        page.type("#goal-add-amount", "25000")
        page.click("#modal-goal-add button[type=submit]")
        esperar_fila_vazia(page)
        d = db(page)
        checar(abs(d["metas"][0]["current"] - 750) < 0.001 and len(d["metas"][0]["contributions"]) == 1 and d["metas"][0]["contributions"][0]["by"] == "u1", "aporte de 250 registrado com autor")
        page.click("#goals-list .goal-icon-btn.warn")
        esperar_fila_vazia(page)
        checar(db(page)["metas"][0]["archived"] is True, "meta arquivada")
        page.click("[data-goal-tab='archived']")
        page.click("#goals-list .goal-icon-btn.danger")
        page.wait_for_selector("#modal-confirm.active")
        page.click("#confirm-ok")
        esperar_fila_vazia(page)
        checar(len(db(page)["metas"]) == 0, "meta excluída após confirmação")

        print("\n== 10. Contas e orçamento")
        page.evaluate("openPage('settings')")
        page.click("[data-settings-tab='accounts']")
        page.click("[data-settings-panel='accounts'] .settings-action-btn")
        page.wait_for_selector("#modal-account.active")
        page.fill("#account-name", "Nubank")
        page.select_option("#account-type", "Cartão de crédito")
        page.click("#account-color-swatches .swatch:nth-child(3)")
        page.click("#modal-account button[type=submit]")
        esperar_fila_vazia(page)
        d = db(page)
        nb = [c for c in d["contas"] if c["name"] == "Nubank"]
        checar(len(nb) == 1 and nb[0]["color"] == "#9c7cfa" and nb[0]["type"] == "Cartão de crédito", "conta Nubank gravada com cor e tipo")
        page.fill("#settings-budgets-list .budget-row:nth-child(3) input", "")
        page.type("#settings-budgets-list .budget-row:nth-child(3) input", "80000")
        page.press("#settings-budgets-list .budget-row:nth-child(3) input", "Tab")
        esperar_fila_vazia(page)
        d = db(page)
        orc = [o for o in d["orcamentos"] if o["category"] == "food"]
        checar(len(orc) == 1 and abs(orc[0]["amount"] - 800) < 0.001, "orçamento de Alimentação = 800 no banco")

        print("\n== 11. Perfil: nome e cor")
        page.click("[data-settings-tab='profile']")
        page.fill("#settings-name", "Daniel B.")
        page.click("#settings-color-swatches .swatch:nth-child(5)")
        page.click("[data-settings-panel='profile'].bg-brand")
        esperar_fila_vazia(page)
        d = db(page)
        m = [x for x in d["membros"] if x["user_id"] == "u1"][0]
        checar(m["nome"] == "Daniel B." and m["cor"] == "#00c853", "perfil gravado em membros")

        print("\n== 12. Sem internet: fila guarda e envia quando volta")
        page.evaluate("Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); window.dispatchEvent(new Event('offline'));")
        lancar(page, "4500", "Padaria", status="paid")
        time.sleep(0.5)
        checar(txt(page, "#settings-queue-count").strip() == "1", "1 alteração esperando internet")
        checar(not [r for r in db(page)["lancamentos"] if r["description"] == "Padaria"], "banco ainda não tem 'Padaria'")
        checar("Padaria" in txt(page, "#dash-tx-list") or page.evaluate("State.transactions.some(t => t.description === 'Padaria')"), "tela já mostra 'Padaria'")
        page.evaluate("Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online'));")
        esperar_fila_vazia(page)
        checar(len([r for r in db(page)["lancamentos"] if r["description"] == "Padaria"]) == 1, "'Padaria' chegou ao banco quando a internet voltou")

        print("\n== 13. Tempo real entre duas pessoas (segunda aba = Maria)")
        page2 = ctx.new_page()
        rotear(page2)
        entrar(page2, "maria@teste.com")
        page.bring_to_front()
        page.evaluate("openPage('dashboard')")
        page.evaluate("document.querySelectorAll('.toast').forEach(t => t.remove())")
        lancar(page2, "9990", "Luz", status="pending")
        page.wait_for_function("State.transactions.some(t => t.description === 'Luz')", timeout=10000)
        tx_luz = page.evaluate("State.transactions.find(t => t.description === 'Luz')")
        checar(tx_luz["updatedBy"] == "u2", "lançamento da Maria chegou na aba do Daniel com autor u2")
        page.wait_for_selector(".toast:has-text('Maria lançou a despesa')", timeout=10000)
        checar(True, "aviso 'Maria lançou a despesa' apareceu")
        page.evaluate("openPage('transactions')")
        checar("Maria" in txt(page, "#tx-list .tx-item:has-text('Luz') .tx-sub"), "lista mostra '· Maria' no lançamento")
        page2.click("#bottom-nav .nav-item[data-page='control']")
        page2.click("[data-control-tab='expense']")
        page2.click("#control-expense-list .tx-item:has-text('Luz') .toggle-status-btn")
        page.wait_for_function("State.transactions.find(t => t.description === 'Luz')?.status === 'paid'", timeout=10000)
        checar(True, "pagamento feito pela Maria refletiu na aba do Daniel")
        page.wait_for_selector(".toast:has-text('marcou como pago')", timeout=10000)
        checar(True, "aviso 'Maria marcou como pago' apareceu")
        page2.evaluate("openPage('transactions')")
        page2.wait_for_function("State.transactions.some(t => t.description === 'Padaria')", timeout=10000)
        checar(True, "aba da Maria também tem os lançamentos do Daniel")
        page2.close()

        print("\n== 14. Importar dados da versão antiga guardados no aparelho")
        page3 = ctx.new_page()
        rotear(page3)
        page3.goto(BASE)
        page3.evaluate("localStorage.clear(); sessionStorage.clear();")
        legado = {
            "profile": {"name": "Daniel", "email": "daniel@teste.com"},
            "accounts": [{"id": "checking", "name": "Conta Principal", "type": "Conta corrente", "color": "#00b4a0"}, {"id": "9999_itau", "name": "Itaú", "type": "Conta corrente", "color": "#ff8a50"}],
            "budgets": {"home": 1500, "food": 0},
            "goals": [{"id": "g1", "title": "Reserva", "category": "emergency", "deadline": "2027-06", "target": 10000, "current": 2500, "contributions": []}],
            "transactions": [
                {"id": "1700000000001", "type": "expense", "amount": 1200, "description": "Aluguel", "date": f"{hoje[:7]}-05", "category": "home", "accountId": "checking", "paymentMethod": "pix", "status": "paid", "recurring": False},
                {"id": "1700000000002", "type": "income", "amount": 3500, "description": "Salário antigo", "date": f"{hoje[:7]}-01", "category": "salary", "accountId": "9999_itau", "paymentMethod": "pix", "status": "paid", "recurring": False},
                {"id": "1700000000003", "type": "expense", "amount": 99.9, "description": "Farmácia", "date": f"{hoje[:7]}-10", "category": "health", "accountId": "conta_que_nao_existe", "paymentMethod": "debit", "status": "pending", "recurring": False},
            ],
        }
        page3.evaluate("(l) => localStorage.setItem('golbuy_v7:daniel@teste.com', JSON.stringify(l))", legado)
        entrar(page3, "daniel@teste.com")
        page3.wait_for_selector("#modal-confirm.active", timeout=10000)
        checar("3 lançamentos e 1 metas" in txt(page3, "#confirm-message"), "pergunta de importação com 3 lançamentos e 1 meta")
        page3.click("#confirm-ok")
        esperar_fila_vazia(page3)
        d = db(page3)
        checar(len(d["lancamentos"]) == 3 and len(d["metas"]) == 1, "3 lançamentos e 1 meta importados")
        checar(any(c["id"] == "9999_itau" for c in d["contas"]), "conta Itaú criada na importação")
        farm = [r for r in d["lancamentos"] if r["description"] == "Farmácia"][0]
        checar(farm["account_id"] == "checking", "conta inexistente caiu na conta principal")
        checar(any(o["category"] == "home" and abs(o["amount"] - 1500) < 0.001 for o in d["orcamentos"]), "orçamento de Moradia importado")
        checar("R$ 1.299,90" in txt(page3, "#dash-expense"), "painel do mês mostra as despesas importadas")
        page3.close()

        print("\n== 14b. Importar da nuvem antiga (tabela user_states do mesmo projeto)")
        page5 = ctx.new_page()
        rotear(page5)
        page5.goto(BASE)
        page5.evaluate("localStorage.clear(); sessionStorage.clear();")
        nuvem_antiga = {
            "profile": {"name": "Daniel", "email": "daniel@teste.com"},
            "accounts": [{"id": "checking", "name": "Conta Principal", "type": "Conta corrente", "color": "#00b4a0"}],
            "budgets": {},
            "goals": [],
            "transactions": [
                {"id": "1600000000001", "type": "expense", "amount": 350, "description": "Condomínio", "date": f"{hoje[:7]}-03", "category": "home", "accountId": "checking", "paymentMethod": "pix", "status": "paid", "recurring": False},
                {"id": "1600000000002", "type": "income", "amount": 1000, "description": "Freela", "date": f"{hoje[:7]}-04", "category": "freelance", "accountId": "checking", "paymentMethod": "pix", "status": "pending", "recurring": False},
            ],
        }
        page5.evaluate("""(l) => { const db = window.__mockSeed(); db.user_states = [{ user_id: 'u1', app_state: l, updated_at: new Date().toISOString() }]; localStorage.setItem('mock-db', JSON.stringify(db)); }""", nuvem_antiga)
        entrar(page5, "daniel@teste.com")
        page5.wait_for_selector("#modal-confirm.active", timeout=10000)
        checar("na nuvem antiga" in txt(page5, "#confirm-message") and "2 lançamentos" in txt(page5, "#confirm-message"), "pergunta cita a nuvem antiga com 2 lançamentos")
        page5.click("#confirm-ok")
        esperar_fila_vazia(page5)
        d = db(page5)
        checar(len(d["lancamentos"]) == 2 and {r["description"] for r in d["lancamentos"]} == {"Condomínio", "Freela"}, "2 lançamentos vieram da nuvem antiga para a casa")
        page5.close()

        print("\n== 15. Recuperação de senha e troca")
        page4 = ctx.new_page()
        rotear(page4)
        page4.goto(BASE)
        page4.evaluate("sessionStorage.clear();")
        page4.reload()
        page4.wait_for_selector("#auth-shell:not(.hidden)")
        page4.fill("#auth-email", "daniel@teste.com")
        page4.click("#auth-forgot-btn")
        page4.wait_for_function("document.getElementById('auth-status').textContent.includes('Enviei um link')")
        reset = page4.evaluate("window.__mockResetFor")
        checar(reset["email"] == "daniel@teste.com" and reset["opts"]["redirectTo"].endswith("/v2/index.html"), "pedido de recuperação com link de volta para o app")
        entrar(page4, "daniel@teste.com")
        page4.evaluate("window.__mockFireRecovery()")
        page4.wait_for_selector("#modal-password-change.active")
        page4.fill("#force-new-password", "novasenha1")
        page4.fill("#force-confirm-password", "novasenha1")
        page4.click("#force-password-submit")
        page4.wait_for_function("!document.getElementById('modal-password-change').classList.contains('active')")
        checar(page4.evaluate("window.__mockLastPassword") == "novasenha1", "nova senha enviada ao banco")
        page4.close()

        print("\n== 15b. Administrador: nome da casa, renomear, convidar, atividade")
        page.evaluate("openPage('settings')")
        page.click("[data-settings-tab='casa']")
        page.wait_for_timeout(300)
        checar(page.is_visible("#casa-convites-card") and page.is_visible("#casa-perigo-card") and page.is_visible("#casa-nome-form"), "administrador vê convites, nome da casa e zona de perigo")
        checar("administrador" in txt(page, "#casa-members"), "lista marca quem é administrador")
        page.fill("#casa-nome-input", "Casa Nova")
        page.click("#casa-nome-form button")
        esperar_fila_vazia(page)
        checar(db(page)["casas"][0]["nome"] == "Casa Nova" and txt(page, "#sidebar-casa-name").strip() == "Casa Nova", "nome da casa gravado e refletido na barra")
        page.click("#casa-members .member-item:nth-child(2) .member-btn:not(.danger)")
        page.wait_for_selector("#modal-prompt.active")
        page.fill("#prompt-input", "Maria Silva")
        page.click("#prompt-ok")
        esperar_fila_vazia(page)
        checar([x for x in db(page)["membros"] if x["user_id"] == "u2"][0]["nome"] == "Maria Silva", "Maria renomeada pelo administrador")
        page.fill("#convite-email", "joao@teste.com")
        page.click("#casa-convites-card .admin-secondary-btn")
        esperar_fila_vazia(page)
        checar(any(c["email"] == "joao@teste.com" for c in db(page)["convites"]), "convite gravado no banco")
        checar("joao@teste.com" in txt(page, "#casa-convites"), "convite aparece como pendente")
        page.click("#historico-atualizar")
        page.wait_for_selector("#casa-historico .admin-audit-item", timeout=10000)
        checar("lançou" in txt(page, "#casa-historico"), "atividade recente lista quem lançou")

        print("\n== 15c. Membro comum não vê controles de administrador")
        page2 = ctx.new_page()
        rotear(page2)
        entrar(page2, "maria@teste.com")
        page2.evaluate("openPage('settings')")
        page2.click("[data-settings-tab='casa']")
        page2.wait_for_timeout(300)
        checar(not page2.is_visible("#casa-convites-card") and not page2.is_visible("#casa-perigo-card") and not page2.is_visible("#casa-nome-form"), "Maria não vê convites, nome da casa nem zona de perigo")
        checar(page2.evaluate("State.profile.name") == "Maria Silva", "Maria já vê o nome novo")
        page2.close()

        print("\n== 15d. Criar conta com convite (e recusa sem convite)")
        page6 = ctx.new_page()
        rotear(page6)
        page6.goto(BASE)
        page6.evaluate("sessionStorage.clear()")
        page6.reload()
        page6.wait_for_selector("#auth-shell:not(.hidden)")
        page6.click("#auth-signup-toggle")
        page6.fill("#signup-name", "Intruso")
        page6.fill("#signup-email", "intruso@teste.com")
        page6.fill("#signup-password", "123456")
        page6.fill("#signup-confirm", "123456")
        page6.click("#signup-submit-btn")
        page6.wait_for_function("document.getElementById('auth-status').textContent.includes('não foi convidado')", timeout=10000)
        checar(True, "sem convite, o cadastro é recusado com mensagem clara")
        page6.fill("#signup-name", "João")
        page6.fill("#signup-email", "joao@teste.com")
        page6.click("#signup-submit-btn")
        page6.wait_for_selector("#app:not(.hidden)", timeout=10000)
        page6.wait_for_function("document.getElementById('live-indicator').classList.contains('ok')", timeout=10000)
        checar(page6.evaluate("State.members.length") == 4 and page6.evaluate("State.profile.name") == "João", "João entrou na casa pelo convite com o nome escolhido")
        checar(not page6.is_visible("#casa-convites-card"), "João não é administrador")
        page6.close()
        page.click("#historico-atualizar")
        page.wait_for_timeout(500)
        checar("joao@teste.com" not in txt(page, "#casa-convites"), "convite usado some da lista do administrador")

        print("\n== 15e. Pergunta do nome quando o nome ainda é o pedaço do e-mail")
        page8 = ctx.new_page()
        rotear(page8)
        entrar(page8, "ana@teste.com")
        page8.wait_for_selector("#modal-prompt.active", timeout=10000)
        checar("Como você quer aparecer" in txt(page8, "#prompt-title"), "app pergunta o nome da Ana")
        page8.fill("#prompt-input", "Ana Paula")
        page8.click("#prompt-ok")
        esperar_fila_vazia(page8)
        checar([x for x in db(page8)["membros"] if x["user_id"] == "u3"][0]["nome"] == "Ana Paula", "nome da Ana gravado")
        page8.close()

        print("\n== 15f. Apagar todos os dados da casa (só com a palavra APAGAR)")
        page.bring_to_front()
        page.click("#apagar-tudo-btn")
        page.wait_for_selector("#modal-prompt.active")
        page.fill("#prompt-input", "nao")
        page.click("#prompt-ok")
        page.wait_for_timeout(300)
        checar(len(db(page)["lancamentos"]) > 0, "palavra errada não apaga nada")
        page.click("#apagar-tudo-btn")
        page.wait_for_selector("#modal-prompt.active")
        page.fill("#prompt-input", "APAGAR")
        page.click("#prompt-ok")
        page.wait_for_function("State.transactions.length === 0", timeout=10000)
        d = db(page)
        checar(len(d["lancamentos"]) == 0 and len(d["metas"]) == 0 and len(d["orcamentos"]) == 0, "lançamentos, metas e orçamentos apagados")
        checar(len(d["contas"]) >= 3 and len(d["membros"]) >= 4, "contas e pessoas continuam")
        checar("apagou todos os dados" in txt(page, "#casa-historico"), "atividade registra o apagamento")

        print("\n== 17. Vencimento e data de pagamento em meses diferentes")
        page.evaluate("openPage('dashboard')")
        abrir_modal_tx(page)
        checar(page.input_value("#tx-pay-date") == page.input_value("#tx-date"), "pagamento começa igual ao vencimento")
        page.fill("#tx-date", "2026-11-20")
        checar(page.input_value("#tx-pay-date") == "2026-11-20", "pagamento acompanha o vencimento enquanto não é mexido")
        page.click("#tx-pay-next")
        checar(page.input_value("#tx-pay-date") == "2026-12-20", "botão 'mês seguinte' joga o pagamento um mês à frente")
        page.fill("#tx-pay-date", "2026-12-05")
        page.fill("#tx-date", "2026-11-21")
        checar(page.input_value("#tx-pay-date") == "2026-12-05", "depois de mexido, o pagamento não acompanha mais")
        dica = txt(page, "#tx-pay-hint")
        checar("novembro" in dica and "dezembro" in dica, f"aviso explica em que mês conta ({dica})")
        page.fill("#tx-amount", "")
        page.type("#tx-amount", "30000")
        page.fill("#tx-desc", "Cartão de crédito")
        page.select_option("#tx-category", "credit_card")
        page.click("#form-tx button[type=submit]")
        page.wait_for_function("!document.getElementById('modal-tx').classList.contains('active')")
        esperar_fila_vazia(page)
        row = [r for r in db(page)["lancamentos"] if r["description"] == "Cartão de crédito"][0]
        checar(row["date"] == "2026-11-21" and row["data_pagamento"] == "2026-12-05", "banco guarda vencimento e pagamento")
        page.evaluate("openPage('transactions'); updateTxFromInput('2026-11')")
        page.wait_for_timeout(200)
        checar("Cartão de crédito" not in txt(page, "#tx-list"), "não aparece no mês do vencimento")
        page.evaluate("updateTxFromInput('2026-12')")
        page.wait_for_timeout(200)
        lista = txt(page, "#tx-list")
        checar("Cartão de crédito" in lista and "vence" in lista and "nov" in lista.lower(), "aparece no mês do pagamento, com o vencimento ao lado")
        page.evaluate(f"editTransaction('{row['id']}')")
        page.wait_for_selector("#modal-tx.active")
        checar(page.input_value("#tx-date") == "2026-11-21" and page.input_value("#tx-pay-date") == "2026-12-05", "edição mostra as duas datas")
        page.click("#form-tx button[type=submit]")
        page.wait_for_function("!document.getElementById('modal-tx').classList.contains('active')")
        esperar_fila_vazia(page)
        row = [r for r in db(page)["lancamentos"] if r["description"] == "Cartão de crédito"][0]
        checar(row["data_pagamento"] == "2026-12-05", "salvar sem mexer mantém a data de pagamento")
        page.evaluate("openPage('calendar'); calDate = new Date(2026, 11, 1); State.calendarSelectedDate = null; renderCalendar();")
        page.click("button[onclick=\"selectCalendarDay('2026-12-05')\"]")
        page.wait_for_timeout(200)
        checar("Cartão de crédito" in txt(page, "#cal-day-list"), "calendário mostra no dia do pagamento")
        lancar(page, "9900", "Internet", categoria="home", recorrente=True, vencimento="2026-11-20", pagamento="2026-12-05")
        esperar_fila_vazia(page)
        serie = sorted([r for r in db(page)["lancamentos"] if r["description"] == "Internet"], key=lambda r: r["date"])
        checar(len(serie) >= 2 and serie[1]["date"] == "2026-12-20" and serie[1]["data_pagamento"] == "2027-01-05", "recorrência desloca as duas datas")
        lancar(page, "5000", "Padaria", vencimento="2026-12-03", pagamento="2026-12-03")
        esperar_fila_vazia(page)
        row = [r for r in db(page)["lancamentos"] if r["description"] == "Padaria"][0]
        checar(row["data_pagamento"] is None, "mesmo dia guarda pagamento vazio (segue o vencimento)")
        lancar(page, "250000", "Salário", tipo="income", status="paid", vencimento="2026-12-05")
        esperar_fila_vazia(page)
        page.evaluate("openPage('transactions'); updateTxFromInput('2026-12')")
        page.wait_for_timeout(200)
        checar(int(txt(page, "#tx-income-tab-count")) == 1 and int(txt(page, "#tx-expense-tab-count")) >= 3, "receita e despesas do mesmo mês de pagamento juntas")

        print("\n== 17b. Banco ainda sem a coluna data_pagamento")
        page.evaluate("sessionStorage.setItem('mock-sem-colunas', JSON.stringify({ lancamentos: ['data_pagamento'] }))")
        page.reload()
        page.wait_for_function("document.getElementById('live-indicator').classList.contains('ok')", timeout=10000)
        page.wait_for_function("payDateChecked === true", timeout=10000)
        checar(page.evaluate("payDateSupported") is False, "app percebe que a coluna não existe")
        abrir_modal_tx(page)
        checar((not page.is_visible("#tx-pay-wrap")) and page.is_visible("#tx-pay-unsupported"), "campo de pagamento escondido e aviso para rodar o SQL")
        page.evaluate("closeModalTx()")
        lancar(page, "1500", "Pão")
        esperar_fila_vazia(page)
        checar(any(r["description"] == "Pão" for r in db(page)["lancamentos"]), "lançamento salva mesmo sem a coluna")
        page.evaluate("sessionStorage.removeItem('mock-sem-colunas')")
        page.reload()
        page.wait_for_function("document.getElementById('live-indicator').classList.contains('ok')", timeout=10000)
        page.wait_for_function("payDateChecked === true", timeout=10000)
        checar(page.evaluate("payDateSupported") is True, "com a coluna de volta, o campo volta")

        print("\n== 16. Sair da conta limpa a tela")
        page.evaluate("openPage('settings')")
        page.click("[data-settings-tab='casa']")
        page.click("[data-settings-panel='casa'] .text-expense")
        page.wait_for_selector("#auth-shell:not(.hidden)", timeout=10000)
        checar(page.evaluate("State.transactions.length") == 0, "estado zerado após sair")

        print("\n== Erros de JavaScript durante os testes")
        for e in erros_console:
            print("  ", e)
        checar(not erros_console, "nenhum erro de JavaScript")

        browser.close()
    httpd.shutdown()

    print("\n=========================================")
    if falhas:
        print(f"{len(falhas)} FALHA(S):")
        for f in falhas:
            print(" -", f)
        sys.exit(1)
    print("TUDO OK")


if __name__ == "__main__":
    main()
