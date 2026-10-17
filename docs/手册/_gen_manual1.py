# -*- coding: utf-8 -*-
"""SCADIA 软件使用手册（3.0.0 · 组态全量版）

结构：
  前置      阅读说明与版本记录
  第 1–4 章 入门与工程基础          _m1_part1.py
  第 5–8 章 变量、设备、地址、画面    _m1_part2.py
  第 9–10 章 图形控件、动画连接       _m1_graphics.py
  第 11–13 章 事件、脚本、数据表      _m1_logic.py
  第 14 章  报警                     _m1_alarm.py
  第 15 章  趋势曲线                 _m1_trend.py
  第 16–17 章 报表、配方              _m1_report.py
  第 18–20 章 权限、历史备份、排障     _m1_admin.py
  第 21–24 章 八场景、统计、记录、AI   _m1_ai.py
  第 25–26 章 值班清单、速查卡 + 附录  _m1_ops.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _gen_lib import *

import _m1_ai
import _m1_admin
import _m1_alarm
import _m1_graphics
import _m1_logic
import _m1_ops
import _m1_accept
import _m1_part1
import _m1_part2
import _m1_practice
import _m1_practice2
import _m1_report
import _m1_trend

doc = build_doc(
    '软件使用手册', '从零基础到独立组态 · 全字段逐步图解版',
    '3.0.0',
    [('文档名称', 'SCADIA 工业监控与八场景视频分析系统 · 软件使用手册'),
     ('适用版本', 'SCADIA 3.0.0（界面收敛版，源码基线 2026-10-17）'),
     ('读者对象', '值班员、组态工程师、系统管理员、验收人员'),
     ('阅读前提', '不需要编程基础；第 5–17 章为组态实操，可按需选读'),
     ('编写日期', '2026-10-18'),
     ('配套文档', '《SCADIA 工程配置与修改手册》《部署维护手册》《产品说明书》')],
    'SCADIA 软件使用手册')

h1(doc, '阅读说明与版本记录')
para(doc, '本手册讲两件事：一是作为值班人员，怎么用这套软件看画面、确认事件、处理报警；二是作为组态人员，怎么从零把一个工程配起来——建变量、接设备、画画面、做动画、写脚本、配报警、做趋势和报表。')
para(doc, '第二件事和组态王、WinCC 属于同一类工作。本手册按“点哪里、填什么、填完什么样算对”的粒度写，每个配置面都给出字段表；凡是产品做不到的，直接写在“边界”里，不用模糊话掩盖。')
note(doc, '本手册不包含任何现场密码、相机地址、模型密钥。凡出现 <尖括号占位>，都表示“向系统管理员索取实际值”。')
table(doc, [
    ['版本', '日期', '修订内容'],
    ['1.0', '2026-10-15', '首版：登录、画面、门口标定、统一 AI、历史记录、报警确认'],
    ['2.0', '2026-10-16', '补充八场景统一分析、历史证据页、凭据与权限边界'],
    ['3.0.0', '2026-10-17', '界面收敛：菜单只保留八算法相关入口；新增“报表 · 账号活动”'],
    ['3.0.0-d', '2026-10-18', '组态部分全量扩写：变量词典、18 类驱动与地址规则、画面属性、'
                            '18 类控件、17 种动画、9 种事件、21 个系统函数、报警四档、趋势四轴、报表四项'],
], widths=[2.4, 2.8, 11.3])

start_body(doc, 'SCADIA 软件使用手册')

_m1_part1.build(doc)
_m1_part2.build(doc)
_m1_graphics.build(doc)
_m1_logic.build(doc)
_m1_alarm.build(doc)
_m1_trend.build(doc)
_m1_report.build(doc)
_m1_admin.build(doc)
_m1_ai.build(doc)
_m1_ops.ch25(doc)
_m1_ops.ch26(doc)
_m1_practice.build(doc)
_m1_practice2.build(doc)
_m1_accept.build(doc)
_m1_ops.appendix(doc)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'SCADIA_软件使用手册_3.0.0.docx')
doc.save(out)
print('saved', out)
