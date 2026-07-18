format = 'UDZO'
filesystem = 'HFS+'

files = [(defines['app_path'], 'Lunery Lab Studio.app')]
symlinks = {'Applications': '/Applications'}
icon = defines['volume_icon']
badge_icon = None

background = 'builtin-arrow'
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
window_rect = ((200, 120), (660, 400))

default_view = 'icon-view'
show_icon_preview = False
include_icon_view_settings = True
arrange_by = None
label_pos = 'bottom'
text_size = 16
icon_size = 128
icon_locations = {
    'Lunery Lab Studio.app': (180, 170),
    'Applications': (480, 170),
}
hide_extensions = ['Lunery Lab Studio.app']
