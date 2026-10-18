# сквозная проверка в настоящем браузере (телефонный размер): все уроки, разделы, контрольная, перезагрузка
import subprocess, time, json, sys, re
from playwright.sync_api import sync_playwright

PORT = '8099'
BASE = 'http://localhost:' + PORT + '/index.html'
srv = subprocess.Popen([sys.executable, '-m', 'http.server', PORT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
errors, notes = [], []
course = json.load(open('content/course.json', encoding='utf-8'))

def play_exercises(page, limit=300, answer='zzz'):
    n = 0
    while n < limit:
        if page.locator('h1:has-text("Урок пройден")').count() or page.locator('text=Результат с первой попытки').count(): break
        if page.locator('button.opt').count():
            page.locator('button.opt').first.click()
        elif page.locator('input[type=text]').count():
            page.fill('input[type=text]', answer)
            page.click('button:has-text("Проверить")')
        else:
            break
        n += 1
        page.click('button:has-text("Дальше")')
    return n

def finish_lesson(page, lid):
    page.goto(BASE + '#/lesson/' + lid)
    page.wait_for_selector('text=Цель урока')
    page.click('button:has-text("К новым словам")')
    while page.locator('button:has-text("К упражнениям")').count() == 0:
        page.click('button:has-text("Дальше")')
    page.click('button:has-text("К упражнениям")')
    if page.locator('text=Диалог:').count():
        page.click('button:has-text("К упражнениям")')
    return play_exercises(page)

def no_overflow(page, label):
    w = page.evaluate('[document.documentElement.scrollWidth, window.innerWidth]')
    if w[0] > w[1] + 1: notes.append('горизонтальная прокрутка на ' + label + ': ' + str(w))

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 390, 'height': 800}, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(BASE); page.wait_for_selector('text=Начать первый урок')

        # 1. все уроки
        for l in course['lessons']:
            n = finish_lesson(page, l['id'])
            print(l['id'], 'шагов', n)
        data = page.evaluate("JSON.parse(localStorage.getItem('english-path:progress'))")
        print('пройдено уроков:', len(data['completedLessons']), '| слов в SRS:', len(data['srs']), '| навыки:', {k: v['total'] for k, v in data['skills'].items()})
        assert len(data['completedLessons']) == len(course['lessons'])
        # слов в SRS = всего слов в курсе: ничего не потерялось и не задублировалось
        total_words = 0
        for l in course['lessons']:
            total_words += len(json.load(open('content/' + l['file'], encoding='utf-8'))['vocab'])
        assert len(data['srs']) == total_words, (len(data['srs']), total_words)
        # в грамматику не попали слова и неграмматические темы
        print('темы грамматики в прогрессе:', sorted(data['grammar'].keys()))
        assert 'Слова' not in data['grammar'] and 'Приветствия' not in data['grammar'] and 'Чтение' not in data['grammar']

        # 2. разделы
        for r in ['more', 'program', 'vocab', 'stats', 'settings', 'grammar', 'reading', 'listening', 'talk', 'tests', 'review']:
            page.goto(BASE + '#/' + r); page.wait_for_selector('h1'); no_overflow(page, r)
        page.goto(BASE + '#/grammar'); page.wait_for_selector('text=Прочитать объяснение')
        page.screenshot(path='/tmp/e2e-grammar.png')
        page.goto(BASE + '#/explain/preA1-03'); page.wait_for_selector('text=Открыть урок с упражнениями')
        no_overflow(page, 'explain')

        # 3. тренировка слабой темы
        page.goto(BASE + '#/drill/' + 'to%20be'); page.wait_for_selector('h1')
        k = play_exercises(page, 40)
        print('тренировка to be, шагов:', k, '|', page.inner_text('h1'))
        assert page.locator('h1:has-text("Тренировка завершена")').count() == 1

        # 4. чтение
        page.goto(BASE + '#/reading'); page.wait_for_selector('text=Tom and his dog')
        page.goto(BASE + '#/read/read-tom-dog'); page.wait_for_selector('text=Ответить на вопросы')
        page.click('button:has-text("Показать перевод")')
        assert page.locator('text=Это Том.').is_visible()
        page.screenshot(path='/tmp/e2e-reading.png')
        page.click('button:has-text("Слушать целиком")')
        page.wait_for_selector('#toast.show', timeout=4000)
        print('озвучка текста без голоса ->', page.inner_text('#toast'))
        page.click('button:has-text("Ответить на вопросы")')
        k = play_exercises(page, 20)
        print('вопросы к тексту:', k, '|', page.inner_text('h1'))

        # 5. аудирование
        page.goto(BASE + '#/listening'); page.wait_for_selector('text=Начать диктант')
        page.click('button:has-text("Начать диктант")')
        k = play_exercises(page, 20)
        print('диктант, шагов:', k, '|', page.inner_text('h1'))
        page.click('a:has-text("К аудированию")'); page.wait_for_selector('text=Начать (10)'); page.click('button:has-text("Начать (10)")')
        k = play_exercises(page, 20); print('слова на слух:', k)

        # 6. диалог по ролям
        page.goto(BASE + '#/dialogue/preA1-11'); page.wait_for_selector('text=Сыграть роль')
        page.click('button:has-text("Я — Anna")')
        k = play_exercises(page, 20); print('роль Anna:', k, '|', page.inner_text('h1'))

        # 7. письмо: неполный текст и образцы
        page.goto(BASE + '#/write/w-intro'); page.wait_for_selector('textarea')
        page.fill('textarea', 'Hello I like cats very much')
        page.click('button:has-text("Проверить")'); page.wait_for_selector('text=Не хватает признаков')
        marks = page.locator('text=✗').count()
        print('плохой текст: непройденных признаков', marks)
        assert marks >= 3
        for wid in ['w-intro', 'w-family']:
            sample = [w for w in course['writing'] if w['id'] == wid][0]['sample']
            page.goto(BASE + '#/write/' + wid); page.wait_for_selector('textarea')
            page.fill('textarea', sample); page.click('button:has-text("Проверить")')
            page.wait_for_selector('text=Все признаки на месте')
        page.goto(BASE + '#/write/w-intro'); page.wait_for_selector('textarea')
        page.fill('textarea', "My name is Anna. I’m twenty. I'm from Russia. I’m a student.")
        page.click('button:has-text("Проверить")'); page.wait_for_selector('text=Все признаки на месте')
        print('сокращения и типографский апостроф в письме принимаются')

        # 8. контрольная (все ответы неверные: проверяем механику, разбор и отказ в зачёте)
        page.goto(BASE + '#/tests'); page.wait_for_selector('text=Начать')
        page.click('a:has-text("Начать")'); page.wait_for_selector('text=Подсказок нет')
        page.screenshot(path='/tmp/e2e-test-intro.png')
        page.click('button:has-text("Начать")')
        n = 0
        seen_feedback = False
        while page.locator('h1:has-text("Пока не зачтено"), h1:has-text("Зачёт")').count() == 0 and n < 120:
            if page.locator('.fb').count(): seen_feedback = True
            if page.locator('button.opt').count(): page.locator('button.opt').first.click()
            else:
                assert page.locator('button:has-text("Подсказка")').count() == 0, 'в контрольной есть подсказка'
                page.fill('input[type=text]', 'zzz'); page.click('button:has-text("Проверить")')
            n += 1
        print('вопросов в контрольной:', n, '| обратная связь во время теста:', seen_feedback)
        assert not seen_feedback
        page.wait_for_selector('text=Разбор ошибок')
        print('итог:', page.inner_text('h1'), '|', page.locator('text=Общий результат').inner_text())
        page.screenshot(path='/tmp/e2e-test-result.png', full_page=True)
        no_overflow(page, 'результат теста')
        d2 = page.evaluate("JSON.parse(localStorage.getItem('english-path:progress'))")
        assert d2['tests'] and d2['tests'][-1]['passed'] is False

        # 9. перезагрузка: всё на месте
        page.reload(); page.wait_for_selector('h1')
        d3 = page.evaluate("JSON.parse(localStorage.getItem('english-path:progress'))")
        assert d3['profileId'] == data['profileId'] and len(d3['completedLessons']) == len(course['lessons'])
        page.goto(BASE + '#/home'); page.wait_for_selector('h1')
        page.screenshot(path='/tmp/e2e-home2.png')
        print('после перезагрузки: уроков', len(d3['completedLessons']), '| попыток контрольной', len(d3['tests']), '| текстов', len(d3.get('reads', {})), '| писем', len(d3.get('writing', [])))
        b.close()
finally:
    srv.terminate()
print('замечания по вёрстке:', notes or 'нет')
print('ошибки консоли:', errors if errors else 'нет')
