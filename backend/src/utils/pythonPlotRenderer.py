#!/usr/bin/env python3
import argparse
import io
import json
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import pandas as pd

try:
    import seaborn as sns
except Exception:
    sns = None


def parse_args():
    parser = argparse.ArgumentParser(description='Render analytics graph into PNG using Python plotting libs.')
    parser.add_argument('--style', choices=['matplotlib', 'seaborn', 'pandas'], default='seaborn')
    return parser.parse_args()


def to_number(value, default=0.0):
    try:
        number = float(value)
        if number != number:
            return default
        return number
    except Exception:
        return default


def apply_style(style):
    if style == 'seaborn' and sns is not None:
        sns.set_theme(style='whitegrid')
    elif style == 'pandas':
        plt.style.use('ggplot')
    else:
        plt.style.use('default')


def render_no_data(title):
    fig, ax = plt.subplots(figsize=(9, 5), dpi=160)
    ax.axis('off')
    ax.text(0.5, 0.55, title or 'Graph', ha='center', va='center', fontsize=14, fontweight='bold')
    ax.text(0.5, 0.45, 'No data available', ha='center', va='center', fontsize=11, color='#555')
    return fig


def render_bar(ax, graph, style):
    data = graph.get('data') or []
    if not data:
        return False

    df = pd.DataFrame(data)
    x_key = (graph.get('xAxis') or {}).get('key') or (df.columns[0] if len(df.columns) > 0 else None)
    series = graph.get('series') or []
    series_defs = [s for s in series if isinstance(s, dict) and s.get('key') in df.columns]

    if x_key not in df.columns or not series_defs:
        return False

    labels = df[x_key].astype(str).tolist()

    if style == 'pandas':
        y_keys = [s['key'] for s in series_defs]
        df_plot = df[[x_key] + y_keys].copy()
        df_plot.set_index(x_key, inplace=True)
        df_plot.plot(kind='bar', ax=ax)
    elif style == 'seaborn' and sns is not None:
        long_rows = []
        for _, row in df.iterrows():
            for s in series_defs:
                long_rows.append({
                    '__x__': str(row.get(x_key, '')),
                    '__value__': to_number(row.get(s['key'], 0)),
                    '__series__': s.get('label') or s['key']
                })
        long_df = pd.DataFrame(long_rows)
        sns.barplot(data=long_df, x='__x__', y='__value__', hue='__series__', ax=ax)
    else:
        count = len(labels)
        groups = len(series_defs)
        if groups == 0:
            return False
        width = 0.8 / groups
        base_positions = list(range(count))
        for idx, s in enumerate(series_defs):
            offset = -0.4 + (width * idx) + (width / 2.0)
            xpos = [p + offset for p in base_positions]
            yvals = [to_number(v, 0) for v in df[s['key']].tolist()]
            ax.bar(xpos, yvals, width=width, label=s.get('label') or s['key'])
        ax.set_xticks(base_positions)
        ax.set_xticklabels(labels)

    return True


def render_line(ax, graph, style):
    data = graph.get('data') or []
    if not data:
        return False

    df = pd.DataFrame(data)
    x_key = (graph.get('xAxis') or {}).get('key') or (df.columns[0] if len(df.columns) > 0 else None)
    series = graph.get('series') or []
    series_defs = [s for s in series if isinstance(s, dict) and s.get('key') in df.columns]

    if x_key not in df.columns or not series_defs:
        return False

    xvals = df[x_key].tolist()

    if style == 'pandas':
        y_keys = [s['key'] for s in series_defs]
        df_plot = df[[x_key] + y_keys].copy()
        df_plot.set_index(x_key, inplace=True)
        df_plot.plot(kind='line', marker='o', ax=ax)
    elif style == 'seaborn' and sns is not None:
        long_rows = []
        for _, row in df.iterrows():
            for s in series_defs:
                long_rows.append({
                    '__x__': row.get(x_key),
                    '__value__': to_number(row.get(s['key'], 0)),
                    '__series__': s.get('label') or s['key']
                })
        long_df = pd.DataFrame(long_rows)
        sns.lineplot(data=long_df, x='__x__', y='__value__', hue='__series__', marker='o', ax=ax)
    else:
        for s in series_defs:
            yvals = [to_number(v, 0) for v in df[s['key']].tolist()]
            ax.plot(xvals, yvals, marker='o', linewidth=2, label=s.get('label') or s['key'])

    return True


def render_scatter(ax, graph, style):
    series = graph.get('series') or []
    x_key = (graph.get('xAxis') or {}).get('key') or 'x'
    y_key = (graph.get('yAxis') or {}).get('key') or 'y'

    valid_series = [s for s in series if isinstance(s, dict) and isinstance(s.get('data'), list) and len(s.get('data')) > 0]
    if not valid_series:
        return False

    if style == 'seaborn' and sns is not None:
        rows = []
        for s in valid_series:
            for point in s['data']:
                rows.append({
                    '__x__': to_number(point.get(x_key), 0),
                    '__y__': to_number(point.get(y_key), 0),
                    '__series__': s.get('label') or s.get('key') or 'series'
                })
        long_df = pd.DataFrame(rows)
        sns.scatterplot(data=long_df, x='__x__', y='__y__', hue='__series__', s=60, ax=ax)
    elif style == 'pandas':
        for s in valid_series:
            sdf = pd.DataFrame(s['data'])
            if x_key not in sdf.columns or y_key not in sdf.columns:
                continue
            sdf.plot.scatter(x=x_key, y=y_key, s=60, ax=ax, label=s.get('label') or s.get('key') or 'series')
    else:
        for s in valid_series:
            xs = [to_number(point.get(x_key), 0) for point in s['data']]
            ys = [to_number(point.get(y_key), 0) for point in s['data']]
            ax.scatter(xs, ys, s=60, alpha=0.8, label=s.get('label') or s.get('key') or 'series')

    return True


def render_graph(graph, style):
    chart_type = (graph.get('chartType') or '').lower()
    title = graph.get('title') or 'Analytics Graph'
    x_label = (graph.get('xAxis') or {}).get('label') or ''
    y_label = (graph.get('yAxis') or {}).get('label') or ''

    apply_style(style)

    fig, ax = plt.subplots(figsize=(9, 5), dpi=160)
    has_data = False

    if chart_type == 'bar':
        has_data = render_bar(ax, graph, style)
    elif chart_type == 'line':
        has_data = render_line(ax, graph, style)
    elif chart_type == 'scatter':
        has_data = render_scatter(ax, graph, style)

    if not has_data:
        plt.close(fig)
        return render_no_data(title)

    ax.set_title(title, fontsize=13, fontweight='bold')
    if x_label:
        ax.set_xlabel(x_label)
    if y_label:
        ax.set_ylabel(y_label)
    ax.tick_params(axis='x', rotation=20)
    ax.legend(loc='best')

    return fig


def main():
    args = parse_args()
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:
        sys.stderr.write(f'Failed to parse graph payload: {exc}\n')
        sys.exit(2)

    if not isinstance(payload, dict):
        sys.stderr.write('Graph payload must be a JSON object\n')
        sys.exit(2)

    fig = render_graph(payload, args.style)

    buffer = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buffer, format='png', dpi=180)
    plt.close(fig)

    sys.stdout.buffer.write(buffer.getvalue())
    sys.stdout.flush()


if __name__ == '__main__':
    main()
